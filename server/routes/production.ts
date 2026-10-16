import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser, userCan } from '../auth/middleware.js';
import { ah, parseBody, must, parsePagination, page, badRequest } from '../http/helpers.js';
import { notFound, conflict, forbidden, validationError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { newId, formatNo } from '../core/ids.js';
import { round2, ratio } from '../core/money.js';
import {
  evaluateJobAdvance,
  evaluateChangeOrderAdvance,
  type JobStage,
  type ChangeOrderStatus,
} from '../domain/workflow/gates.js';
import type { PermissionKey } from '../core/permissions.js';

const DAY_MS = 86_400_000;

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/* ================================================================== */
/* Projects                                                           */
/* ================================================================== */

export const projects = Router();
projects.use(requireAuth);

/**
 * Project financials.
 *
 * Committed rows are additional commitments that have not been expensed
 * yet, so projected final cost = actuals + commitments (no overlap
 * subtraction — committed and actual rows are recorded separately).
 *
 * This function is only ever called behind the production.financials
 * permission; callers must gate it (see GET /:id which degrades instead
 * of 403ing so a foreman still gets scope and schedule).
 */
export function computeProjectNumbers(projectId: string) {
  const db = getDb();
  const project = db.prepare('SELECT original_contract FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) throw notFound('Project not found.');

  const sum = (sql: string, ...args: any[]) =>
    round2((db.prepare(sql).get(...args) as any).n ?? 0);

  const originalContract = round2(project.original_contract ?? 0);
  const approvedChangeOrders = sum(
    `SELECT COALESCE(SUM(customer_amount), 0) AS n FROM change_orders
      WHERE project_id = ? AND status = 'authorized'`,
    projectId,
  );
  const currentContractValue = round2(originalContract + approvedChangeOrders);
  const estimatedCost = sum('SELECT COALESCE(SUM(estimated_cost), 0) AS n FROM jobs WHERE project_id = ?', projectId);
  const committedCost = sum(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM job_costs WHERE project_id = ? AND kind = 'committed'`,
    projectId,
  );
  const actualCost = sum(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM job_costs WHERE project_id = ? AND kind = 'actual'`,
    projectId,
  );
  const projectedFinalCost = round2(actualCost + committedCost);
  const grossProfit = round2(currentContractValue - projectedFinalCost);
  const grossMargin = ratio(grossProfit, currentContractValue);
  const invoiced = sum(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM invoices WHERE project_id = ? AND status != 'void'`,
    projectId,
  );
  const collected = sum('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE project_id = ?', projectId);
  const remainingReceivable = round2(invoiced - collected);

  // Estimated cost per category: the project's deal → its bid → the newest
  // RELEASED estimate → cost lines grouped by category.
  const releasedEstimate = db
    .prepare(
      `SELECT id FROM estimates
        WHERE bid_id = (SELECT bid_id FROM deals WHERE id = (SELECT deal_id FROM projects WHERE id = ?))
          AND status = 'released'
        ORDER BY version DESC LIMIT 1`,
    )
    .get(projectId) as any;
  const estimatedByCategory = new Map<string, number>();
  if (releasedEstimate) {
    const rows = db
      .prepare(
        `SELECT category_id, COALESCE(SUM(amount), 0) AS n FROM estimate_lines
          WHERE estimate_id = ? AND kind = 'cost' GROUP BY category_id`,
      )
      .all(releasedEstimate.id) as any[];
    for (const r of rows) estimatedByCategory.set(r.category_id ?? '', r.n);
  }

  const costsByCategory = new Map<string, { committed: number; actual: number }>();
  const costRows = db
    .prepare(
      `SELECT category_id, kind, COALESCE(SUM(amount), 0) AS n FROM job_costs
        WHERE project_id = ? GROUP BY category_id, kind`,
    )
    .all(projectId) as any[];
  for (const r of costRows) {
    const entry = costsByCategory.get(r.category_id ?? '') ?? { committed: 0, actual: 0 };
    if (r.kind === 'committed') entry.committed = round2(entry.committed + r.n);
    else if (r.kind === 'actual') entry.actual = round2(entry.actual + r.n);
    costsByCategory.set(r.category_id ?? '', entry);
  }

  const byCategory = (db
    .prepare('SELECT id, key, name FROM cost_categories ORDER BY sort, name')
    .all() as any[]).map((c) => {
    const costs = costsByCategory.get(c.id) ?? { committed: 0, actual: 0 };
    return {
      key: c.key,
      name: c.name,
      estimated: round2(estimatedByCategory.get(c.id) ?? 0),
      committed: costs.committed,
      actual: costs.actual,
    };
  });

  return {
    originalContract,
    approvedChangeOrders,
    currentContractValue,
    estimatedCost,
    committedCost,
    actualCost,
    projectedFinalCost,
    grossProfit,
    grossMargin,
    invoiced,
    collected,
    remainingReceivable,
    byCategory,
  };
}

projects.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const status = String((req.query as any).status ?? '').trim();
    const q = String((req.query as any).q ?? '').trim();

    const where: string[] = [];
    const params: any[] = [];
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (q) {
      where.push('(p.project_no LIKE ? OR p.name LIKE ? OR p.address LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM projects p ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id) AS job_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'open') AS open_task_count,
                (SELECT MAX(dr.report_date) FROM daily_reports dr
                   JOIN jobs j2 ON j2.id = dr.job_id WHERE j2.project_id = p.id) AS last_report_at
           FROM projects p ${clause}
          ORDER BY p.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

projects.get(
  '/:id/numbers',
  requirePermission('production.financials'),
  ah(async (req, res) => {
    must(getDb().prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id), 'Project');
    res.json(computeProjectNumbers(req.params.id));
  }),
);

projects.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const project = must(
      db
        .prepare(
          `SELECT p.*, (co.first_name || ' ' || co.last_name) AS contact_name,
                  c.name AS company_name, d.deal_no
             FROM projects p
             JOIN contacts co ON co.id = p.contact_id
             LEFT JOIN companies c ON c.id = p.company_id
             LEFT JOIN deals d ON d.id = p.deal_id
            WHERE p.id = ?`,
        )
        .get(req.params.id),
      'Project',
    ) as any;

    const at = now();
    const jobs = (
      db
        .prepare(
          `SELECT j.*, cr.name AS crew_name, u.name AS foreman_name
             FROM jobs j
             LEFT JOIN crews cr ON cr.id = j.crew_id
             LEFT JOIN users u ON u.id = j.foreman_id
            WHERE j.project_id = ? ORDER BY j.created_at ASC`,
        )
        .all(project.id) as any[]
    ).map((j) => ({
      ...j,
      days_in_stage: j.stage_entered_at ? Math.floor((at - j.stage_entered_at) / DAY_MS) : 0,
    }));

    const draws = (
      db
        .prepare('SELECT * FROM draw_schedules WHERE project_id = ? ORDER BY version DESC')
        .all(project.id) as any[]
    ).map((s) => ({
      ...s,
      items: db.prepare('SELECT * FROM draw_items WHERE schedule_id = ? ORDER BY seq ASC').all(s.id),
    }));

    const invoices = (
      db
        .prepare('SELECT * FROM invoices WHERE project_id = ? ORDER BY created_at DESC')
        .all(project.id) as any[]
    ).map((i) => ({
      ...i,
      payments: db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_at ASC').all(i.id),
    }));

    const changeOrders = db
      .prepare(
        `SELECT co.*, u.name AS requested_by_name
           FROM change_orders co LEFT JOIN users u ON u.id = co.requested_by
          WHERE co.project_id = ? ORDER BY co.created_at DESC`,
      )
      .all(project.id);

    const recentReports = db
      .prepare(
        `SELECT dr.*, j.job_no, j.trade AS job_trade
           FROM daily_reports dr JOIN jobs j ON j.id = dr.job_id
          WHERE j.project_id = ? ORDER BY dr.report_date DESC LIMIT 20`,
      )
      .all(project.id);

    const openTasks = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.project_id = ? AND t.status = 'open' ORDER BY t.due_at ASC`,
      )
      .all(project.id);

    // The job file is never 403ed — a foreman needs scope and schedule.
    // Financials are attached only for holders of production.financials;
    // otherwise the key is null plus a restriction flag for the UI.
    const canSeeFinancials = userCan(req, 'production.financials');
    res.json({
      project,
      jobs,
      draws,
      invoices,
      changeOrders,
      recentReports,
      openTasks,
      financials: canSeeFinancials ? computeProjectNumbers(project.id) : null,
      financialsRestricted: !canSeeFinancials,
    });
  }),
);

/* ================================================================== */
/* Jobs                                                               */
/* ================================================================== */

export const jobs = Router();
jobs.use(requireAuth);

/** First time a job lands in a stage we stamp its stage clock; re-entry keeps the original stamp. */
const STAGE_TIMESTAMP_COLUMN: Partial<Record<JobStage, string>> = {
  in_progress: 'started_at',
  complete: 'completed_at',
  invoiced: 'invoiced_at',
  paid: 'closed_at',
};

const createJobSchema = z.object({
  projectId: z.string().trim().min(1),
  trade: z.string().trim().min(1).max(60),
  name: z.string().trim().max(200).default(''),
  estimatedCost: z.number().nonnegative().default(0),
  scheduledStart: z.number().int().positive().nullish(),
  scheduledEnd: z.number().int().positive().nullish(),
  crewId: z.string().trim().min(1).nullish(),
  foremanId: z.string().trim().min(1).nullish(),
});

/* Costs are registered before /:id so the literal path never collides. */

jobs.get(
  '/costs',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 50);
    const projectId = String((req.query as any).projectId ?? '').trim();
    const jobId = String((req.query as any).jobId ?? '').trim();
    const kind = String((req.query as any).kind ?? '').trim();
    const categoryId = String((req.query as any).categoryId ?? '').trim();
    const from = Number((req.query as any).from ?? 0);
    const to = Number((req.query as any).to ?? 0);

    const where: string[] = [];
    const params: any[] = [];
    if (projectId) { where.push('jc.project_id = ?'); params.push(projectId); }
    if (jobId) { where.push('jc.job_id = ?'); params.push(jobId); }
    if (kind) { where.push('jc.kind = ?'); params.push(kind); }
    if (categoryId) { where.push('jc.category_id = ?'); params.push(categoryId); }
    if (Number.isFinite(from) && from > 0) { where.push('jc.occurred_at >= ?'); params.push(from); }
    if (Number.isFinite(to) && to > 0) { where.push('jc.occurred_at <= ?'); params.push(to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joins = `FROM job_costs jc
      LEFT JOIN cost_categories cat ON cat.id = jc.category_id
      LEFT JOIN vendors v ON v.id = jc.vendor_id
      LEFT JOIN jobs j ON j.id = jc.job_id`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n ${joins} ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT jc.*, cat.name AS category_name, v.name AS vendor_name, j.job_no, j.trade AS job_trade
           ${joins} ${clause}
          ORDER BY jc.occurred_at DESC, jc.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const costSchema = z.object({
  jobId: z.string().trim().min(1),
  categoryId: z.string().trim().min(1).nullish(),
  kind: z.enum(['committed', 'actual']),
  vendorId: z.string().trim().min(1).nullish(),
  description: z.string().trim().max(1000).default(''),
  amount: z.number().positive(),
  occurredAt: z.number().int().positive().nullish(),
  source: z.enum(['manual', 'po', 'invoice', 'change_order']).default('manual'),
  sourceRef: z.string().trim().max(120).nullish(),
});

jobs.post(
  '/costs',
  requirePermission('production.log_cost'),
  ah(async (req, res) => {
    const input = parseBody(costSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const job = must(db.prepare('SELECT id, project_id FROM jobs WHERE id = ?').get(input.jobId), 'Job') as any;
    if (input.categoryId) must(db.prepare('SELECT id FROM cost_categories WHERE id = ?').get(input.categoryId), 'Cost category');
    if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');

    const id = newId('jct');
    const at = now();
    db.prepare(
      `INSERT INTO job_costs (id, job_id, project_id, category_id, kind, vendor_id, description, amount,
         occurred_at, source, source_ref, recorded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, job.id, job.project_id, input.categoryId ?? null, input.kind, input.vendorId ?? null,
      input.description, round2(input.amount), input.occurredAt ?? at, input.source,
      input.sourceRef ?? null, actor.id, at, at,
    );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'cost.recorded',
      entityType: 'job_cost', entityId: id,
      summary: `Recorded ${input.kind} cost of ${round2(input.amount)}`,
      after: { jobId: job.id, kind: input.kind, amount: round2(input.amount), categoryId: input.categoryId ?? null },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM job_costs WHERE id = ?').get(id) });
  }),
);

const costPatchSchema = costSchema.omit({ jobId: true }).partial();

jobs.patch(
  '/costs/:id',
  requirePermission('production.log_cost'),
  ah(async (req, res) => {
    const input = parseBody(costPatchSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM job_costs WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Cost record not found.');
    if (input.categoryId) must(db.prepare('SELECT id FROM cost_categories WHERE id = ?').get(input.categoryId), 'Cost category');
    if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');

    const patch: any = {
      category_id: input.categoryId === undefined ? before.category_id : input.categoryId,
      kind: input.kind ?? before.kind,
      vendor_id: input.vendorId === undefined ? before.vendor_id : input.vendorId,
      description: input.description ?? before.description,
      amount: input.amount === undefined ? before.amount : round2(input.amount),
      occurred_at: input.occurredAt === undefined ? before.occurred_at : input.occurredAt,
      source: input.source ?? before.source,
      source_ref: input.sourceRef === undefined ? before.source_ref : input.sourceRef,
    };
    db.prepare(
      `UPDATE job_costs SET category_id=@category_id, kind=@kind, vendor_id=@vendor_id, description=@description,
         amount=@amount, occurred_at=@occurred_at, source=@source, source_ref=@source_ref,
         updated_at=@updated_at WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM job_costs WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'cost.updated',
      entityType: 'job_cost', entityId: req.params.id,
      summary: `Updated cost record (${before.kind})`, before, after,
    });
    res.json({ row: after });
  }),
);

jobs.delete(
  '/costs/:id',
  requirePermission('production.log_cost'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM job_costs WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Cost record not found.');
    db.prepare('DELETE FROM job_costs WHERE id = ?').run(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'cost.removed',
      entityType: 'job_cost', entityId: req.params.id,
      summary: `Removed ${before.kind} cost of ${before.amount}`, before,
    });
    res.json({ ok: true });
  }),
);

jobs.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const stage = String((req.query as any).stage ?? '').trim();
    const projectId = String((req.query as any).projectId ?? '').trim();
    const foremanId = String((req.query as any).foremanId ?? '').trim();
    const crewId = String((req.query as any).crewId ?? '').trim();
    const q = String((req.query as any).q ?? '').trim();
    const date = Number((req.query as any).date ?? 0);

    const where: string[] = [];
    const params: any[] = [];
    if (stage) { where.push('j.stage = ?'); params.push(stage); }
    if (projectId) { where.push('j.project_id = ?'); params.push(projectId); }
    if (foremanId) { where.push('j.foreman_id = ?'); params.push(foremanId); }
    if (crewId) { where.push('j.crew_id = ?'); params.push(crewId); }
    if (q) {
      where.push('(j.job_no LIKE ? OR j.name LIKE ? OR j.trade LIKE ? OR p.name LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (Number.isFinite(date) && date > 0) {
      // Match the scheduled_start calendar day (UTC epoch-ms boundaries).
      const dayStart = Math.floor(date / DAY_MS) * DAY_MS;
      where.push('j.scheduled_start >= ? AND j.scheduled_start < ?');
      params.push(dayStart, dayStart + DAY_MS);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joins = `FROM jobs j JOIN projects p ON p.id = j.project_id`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n ${joins} ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT j.*, p.name AS project_name ${joins} ${clause}
          ORDER BY j.scheduled_start ASC NULLS LAST, j.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];
    const at = now();
    for (const row of rows) {
      row.days_in_stage = row.stage_entered_at ? Math.floor((at - row.stage_entered_at) / DAY_MS) : 0;
    }
    res.json(page(rows, total, limit, offset));
  }),
);

jobs.post(
  '/',
  requirePermission('production.write'),
  ah(async (req, res) => {
    const input = parseBody(createJobSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId), 'Project');
    if (input.crewId) must(db.prepare('SELECT id FROM crews WHERE id = ?').get(input.crewId), 'Crew');
    if (input.foremanId) must(db.prepare('SELECT id FROM users WHERE id = ?').get(input.foremanId), 'Foreman');

    const id = newId('job');
    tx((txdb) => {
      const dupe = txdb
        .prepare('SELECT id, job_no FROM jobs WHERE project_id = ? AND trade = ?')
        .get(input.projectId, input.trade) as any;
      if (dupe) {
        throw conflict(
          `A ${input.trade} job already exists on this project (${dupe.job_no}). One job per trade per project.`,
          { jobId: dupe.id },
        );
      }
      // Sequential job_no: counted inside the transaction so it cannot race.
      const count = (txdb.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n;
      const at = now();
      txdb
        .prepare(
          `INSERT INTO jobs (id, job_no, project_id, trade, name, stage, scope_snapshot, estimated_cost,
             scheduled_start, scheduled_end, crew_id, foreman_id, stage_entered_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'unscheduled', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, formatNo('JOB', count + 1), input.projectId, input.trade, input.name,
          round2(input.estimatedCost ?? 0), input.scheduledStart ?? null, input.scheduledEnd ?? null,
          input.crewId ?? null, input.foremanId ?? null, at, actor.id, at, at,
        );
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'job.created',
      entityType: 'job', entityId: id,
      summary: `Created ${input.trade} job`,
      after: { projectId: input.projectId, trade: input.trade },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) });
  }),
);

const advanceJobSchema = z.object({
  to: z.enum(['unscheduled', 'scheduled', 'in_progress', 'punch_list', 'complete', 'invoiced', 'paid']),
  authorized: z.boolean().default(false),
});

jobs.post(
  '/:id/advance',
  requirePermission('production.write'),
  ah(async (req, res) => {
    const input = parseBody(advanceJobSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const job = must(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id), 'Job') as any;
    const at = now();
    const dayStart = Math.floor(at / DAY_MS) * DAY_MS;

    const hasSubmittedReports = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM daily_reports WHERE job_id = ? AND status IN ('submitted', 'approved')`)
        .get(job.id) as any
    ).n;
    // Blocker rule: every open HIGH-PRIORITY (priority = 1) task on the job
    // counts as a blocker; openTasks is the total open task count, reported
    // separately so the gate can demand full closeout before completion.
    const openBlockers = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE job_id = ? AND status = 'open' AND priority = 1`)
        .get(job.id) as any
    ).n;
    const openTasks = (
      db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE job_id = ? AND status = 'open'`).get(job.id) as any
    ).n;
    const hasDailyReportToday = !!db
      .prepare('SELECT id FROM daily_reports WHERE job_id = ? AND report_date >= ? AND report_date < ?')
      .get(job.id, dayStart, dayStart + DAY_MS);
    const hasInvoice = (
      db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?').get(job.project_id) as any
    ).n > 0;
    const invoiced = (
      db
        .prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM invoices WHERE project_id = ? AND status != 'void'`)
        .get(job.project_id) as any
    ).n;
    const collected = (
      db
        .prepare(
          `SELECT COALESCE(SUM(p.amount), 0) AS n FROM payments p
             JOIN invoices i ON i.id = p.invoice_id
            WHERE i.project_id = ? AND i.status != 'void'`,
        )
        .get(job.project_id) as any
    ).n;

    const result = evaluateJobAdvance({
      from: job.stage,
      to: input.to,
      stageEnteredAt: job.stage_entered_at,
      now: at,
      hasSchedule: job.scheduled_start != null,
      hasCrewOrForeman: Boolean(job.crew_id || job.foreman_id),
      hasDailyReportToday,
      hasSubmittedReports,
      openBlockers,
      openTasks,
      hasInvoice,
      outstandingBalance: round2(invoiced - collected),
      completionAuthorized: input.authorized || userCan(req, 'production.financials'),
    });

    if (!result.ok) {
      return res.status(409).json({
        error: {
          code: 'conflict',
          message: 'This job cannot move to that stage yet.',
          details: { blockers: result.blockers },
        },
        blockers: result.blockers,
      });
    }

    tx((txdb) => {
      const sets = ['stage = @stage', 'stage_entered_at = @at', 'updated_at = @at'];
      const col = STAGE_TIMESTAMP_COLUMN[input.to as JobStage];
      if (col) sets.push(`${col} = COALESCE(${col}, @at)`);
      txdb
        .prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = @id`)
        .run({ stage: input.to, at, id: job.id });
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'job.stage_changed',
      entityType: 'job', entityId: job.id,
      summary: `Job moved from ${job.stage} to ${input.to}`,
      before: { stage: job.stage }, after: { stage: input.to },
      meta: { blockers: [] },
    });
    res.json({ row: db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) });
  }),
);

const jobPatchSchema = z.object({
  name: z.string().trim().max(200).optional(),
  scheduledStart: z.number().int().positive().nullable().optional(),
  scheduledEnd: z.number().int().positive().nullable().optional(),
  crewId: z.string().trim().min(1).nullish(),
  foremanId: z.string().trim().min(1).nullish(),
  estimatedCost: z.number().nonnegative().optional(),
});

jobs.patch(
  '/:id',
  requirePermission('production.write'),
  ah(async (req, res) => {
    const input = parseBody(jobPatchSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Job not found.');
    if (input.crewId) must(db.prepare('SELECT id FROM crews WHERE id = ?').get(input.crewId), 'Crew');
    if (input.foremanId) must(db.prepare('SELECT id FROM users WHERE id = ?').get(input.foremanId), 'Foreman');

    const patch: any = {
      name: input.name ?? before.name,
      scheduled_start: input.scheduledStart === undefined ? before.scheduled_start : input.scheduledStart,
      scheduled_end: input.scheduledEnd === undefined ? before.scheduled_end : input.scheduledEnd,
      crew_id: input.crewId === undefined ? before.crew_id : input.crewId,
      foreman_id: input.foremanId === undefined ? before.foreman_id : input.foremanId,
      estimated_cost: input.estimatedCost === undefined ? before.estimated_cost : round2(input.estimatedCost),
    };
    db.prepare(
      `UPDATE jobs SET name=@name, scheduled_start=@scheduled_start, scheduled_end=@scheduled_end,
         crew_id=@crew_id, foreman_id=@foreman_id, estimated_cost=@estimated_cost, updated_at=@updated_at
       WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'job.updated',
      entityType: 'job', entityId: req.params.id,
      summary: `Updated job ${before.job_no}`, before, after,
    });
    res.json({ row: after });
  }),
);

const dailyReportSchema = z.object({
  reportDate: z.number().int().positive(),
  workCompleted: z.string().trim().max(8000).default(''),
  laborHours: z.number().nonnegative().default(0),
  crewSize: z.number().int().nonnegative().default(0),
  materialsUsed: z.string().trim().max(4000).default(''),
  equipmentUsed: z.string().trim().max(4000).default(''),
  safetyNotes: z.string().trim().max(4000).default(''),
  delays: z.string().trim().max(4000).default(''),
  blockers: z.string().trim().max(4000).default(''),
  photos: z.array(z.string().trim().max(500)).default([]),
  customerCommCheck: z.boolean().default(false),
  status: z.enum(['draft', 'submitted', 'approved']).default('draft'),
});

jobs.post(
  '/:id/daily-report',
  requirePermission('production.write'),
  ah(async (req, res) => {
    const input = parseBody(dailyReportSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const job = must(db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id), 'Job') as any;
    const at = now();
    const submittedAt = input.status === 'submitted' ? at : null;

    db.prepare(
      `INSERT INTO daily_reports (id, job_id, report_date, foreman_id, status, work_completed, labor_hours,
         crew_size, materials_used, equipment_used, safety_notes, delays, blockers, photos,
         customer_comm_check, submitted_at, created_at, updated_at)
       VALUES (@id, @job_id, @report_date, @foreman_id, @status, @work_completed, @labor_hours,
         @crew_size, @materials_used, @equipment_used, @safety_notes, @delays, @blockers, @photos,
         @customer_comm_check, @submitted_at, @created_at, @updated_at)
       ON CONFLICT(job_id, report_date) DO UPDATE SET
         status = excluded.status, work_completed = excluded.work_completed,
         labor_hours = excluded.labor_hours, crew_size = excluded.crew_size,
         materials_used = excluded.materials_used, equipment_used = excluded.equipment_used,
         safety_notes = excluded.safety_notes, delays = excluded.delays, blockers = excluded.blockers,
         photos = excluded.photos, customer_comm_check = excluded.customer_comm_check,
         submitted_at = CASE WHEN excluded.status = 'submitted' THEN excluded.submitted_at
                             ELSE daily_reports.submitted_at END,
         updated_at = excluded.updated_at`,
    ).run({
      id: newId('drp'),
      job_id: job.id,
      report_date: input.reportDate,
      foreman_id: actor.id,
      status: input.status,
      work_completed: input.workCompleted,
      labor_hours: input.laborHours,
      crew_size: input.crewSize,
      materials_used: input.materialsUsed,
      equipment_used: input.equipmentUsed,
      safety_notes: input.safetyNotes,
      delays: input.delays,
      blockers: input.blockers,
      photos: JSON.stringify(input.photos),
      customer_comm_check: input.customerCommCheck ? 1 : 0,
      submitted_at: submittedAt,
      created_at: at,
      updated_at: at,
    });

    const row = db
      .prepare('SELECT * FROM daily_reports WHERE job_id = ? AND report_date = ?')
      .get(job.id, input.reportDate);
    audit({
      actorId: actor.id, actorName: actor.name,
      action: input.status === 'submitted' ? 'daily_report.submitted' : 'daily_report.updated',
      entityType: 'daily_report', entityId: (row as any)?.id ?? job.id,
      summary: `Daily report for ${new Date(input.reportDate).toISOString().slice(0, 10)} (${input.status})`,
      meta: { jobId: job.id, reportDate: input.reportDate },
    });
    res.status(201).json({ row });
  }),
);

jobs.get(
  '/:id/daily-reports',
  ah(async (req, res) => {
    must(getDb().prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id), 'Job');
    const rows = getDb()
      .prepare('SELECT * FROM daily_reports WHERE job_id = ? ORDER BY report_date DESC')
      .all(req.params.id);
    res.json({ rows, total: rows.length });
  }),
);

jobs.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const job = must(
      db
        .prepare(
          `SELECT j.*, p.name AS project_name, p.project_no, p.status AS project_status,
                  (co.first_name || ' ' || co.last_name) AS contact_name, c.name AS company_name,
                  cr.name AS crew_name, u.name AS foreman_name
             FROM jobs j
             JOIN projects p ON p.id = j.project_id
             JOIN contacts co ON co.id = p.contact_id
             LEFT JOIN companies c ON c.id = p.company_id
             LEFT JOIN crews cr ON cr.id = j.crew_id
             LEFT JOIN users u ON u.id = j.foreman_id
            WHERE j.id = ?`,
        )
        .get(req.params.id),
      'Job',
    ) as any;

    const dailyReports = db
      .prepare('SELECT * FROM daily_reports WHERE job_id = ? ORDER BY report_date DESC')
      .all(job.id);
    const costs = db
      .prepare(
        `SELECT jc.kind, jc.category_id, cat.name AS category_name,
                COUNT(*) AS line_count, COALESCE(SUM(jc.amount), 0) AS total
           FROM job_costs jc LEFT JOIN cost_categories cat ON cat.id = jc.category_id
          WHERE jc.job_id = ?
          GROUP BY jc.kind, jc.category_id
          ORDER BY cat.sort`,
      )
      .all(job.id);
    const changeOrders = db
      .prepare(
        `SELECT co.*, u.name AS requested_by_name
           FROM change_orders co LEFT JOIN users u ON u.id = co.requested_by
          WHERE co.project_id = ? ORDER BY co.created_at DESC`,
      )
      .all(job.project_id);
    const taskRows = db
      .prepare('SELECT * FROM tasks WHERE job_id = ? ORDER BY status, due_at ASC')
      .all(job.id);
    const documents = db
      .prepare(
        `SELECT * FROM documents WHERE owner_type = 'job' AND owner_id = ? ORDER BY created_at DESC`,
      )
      .all(job.id);
    const stageHistory = db
      .prepare(
        `SELECT id, action, summary, actor_name, before, after, meta, at FROM audit_events
          WHERE entity_type = 'job' AND entity_id = ? AND action LIKE 'job.stage%'
          ORDER BY at ASC`,
      )
      .all(job.id);

    res.json({
      job: { ...job, scope_snapshot: parseJson(job.scope_snapshot, {}) },
      dailyReports,
      costs,
      changeOrders,
      tasks: taskRows,
      documents,
      stageHistory,
    });
  }),
);

/* ================================================================== */
/* Change orders                                                      */
/* ================================================================== */

export const changeOrders = Router();
changeOrders.use(requireAuth);

// Every transition is permission-gated before the workflow gate runs:
// pricing is Underwriting's, presenting is Sales', authorizing is the PM's.
const CO_PERMISSIONS: Partial<Record<ChangeOrderStatus, PermissionKey>> = {
  priced: 'changeorder.price',
  internal_approved: 'changeorder.approve_internal',
  customer_presented: 'changeorder.present',
  customer_approved: 'changeorder.present',
  customer_rejected: 'changeorder.present',
  authorized: 'changeorder.authorize',
  void: 'changeorder.approve_internal',
};

changeOrders.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const projectId = String((req.query as any).projectId ?? '').trim();
    const status = String((req.query as any).status ?? '').trim();
    const q = String((req.query as any).q ?? '').trim();

    const where: string[] = [];
    const params: any[] = [];
    if (projectId) { where.push('co.project_id = ?'); params.push(projectId); }
    if (status) { where.push('co.status = ?'); params.push(status); }
    if (q) {
      where.push('(co.co_no LIKE ? OR co.title LIKE ? OR co.description LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM change_orders co ${clause}`)
        .get(...params) as any
    ).n;
    const rows = getDb()
      .prepare(
        `SELECT co.*, p.name AS project_name, u.name AS requested_by_name
           FROM change_orders co
           JOIN projects p ON p.id = co.project_id
           LEFT JOIN users u ON u.id = co.requested_by
          ${clause}
          ORDER BY co.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const createCoSchema = z.object({
  projectId: z.string().trim().min(1),
  jobId: z.string().trim().min(1).nullish(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(8000).default(''),
  scheduleImpact: z.string().trim().max(1000).default(''),
});

changeOrders.post(
  '/',
  requirePermission('changeorder.request'),
  ah(async (req, res) => {
    const input = parseBody(createCoSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId), 'Project');
    if (input.jobId) {
      const job = must(
        db.prepare('SELECT id, project_id FROM jobs WHERE id = ?').get(input.jobId),
        'Job',
      ) as any;
      if (job.project_id !== input.projectId) {
        throw badRequest('That job does not belong to the project.', { jobId: input.jobId });
      }
    }

    const id = newId('co');
    tx((txdb) => {
      // Sequential co_no: counted inside the transaction so it cannot race.
      const count = (txdb.prepare('SELECT COUNT(*) AS n FROM change_orders').get() as any).n;
      const at = now();
      // Creating a request never authorizes work — amounts and approval
      // timestamps stay null until the priced/authorized transitions run.
      txdb
        .prepare(
          `INSERT INTO change_orders (id, co_no, project_id, job_id, title, description, status,
             requested_by, requested_at, schedule_impact, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
        )
        .run(
          id, formatNo('CO', count + 1), input.projectId, input.jobId ?? null, input.title,
          input.description, actor.id, at, input.scheduleImpact, at, at,
        );
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'change_order.requested',
      entityType: 'change_order', entityId: id,
      summary: `Requested change order "${input.title}"`,
      after: { projectId: input.projectId, jobId: input.jobId ?? null, title: input.title },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id) });
  }),
);

changeOrders.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const row = must(
      db
        .prepare(
          `SELECT co.*, p.name AS project_name, p.project_no, u.name AS requested_by_name
             FROM change_orders co
             JOIN projects p ON p.id = co.project_id
             LEFT JOIN users u ON u.id = co.requested_by
            WHERE co.id = ?`,
        )
        .get(req.params.id),
      'Change order',
    ) as any;

    let estimate = null;
    if (row.estimate_id) {
      const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(row.estimate_id) as any;
      if (est) estimate = { ...est, inputs: parseJson(est.inputs, {}), calc: parseJson(est.calc, {}) };
    }
    const trail = db
      .prepare(
        `SELECT id, action, summary, actor_name, before, after, meta, at FROM audit_events
          WHERE entity_type = 'change_order' AND entity_id = ? ORDER BY at ASC`,
      )
      .all(req.params.id);

    res.json({ row, estimate, trail });
  }),
);

const coTransitionSchema = z.object({
  to: z.enum([
    'requested', 'priced', 'internal_approved', 'customer_presented',
    'customer_approved', 'customer_rejected', 'authorized', 'void',
  ]),
  internalAmount: z.number().nonnegative().nullable().optional(),
  customerAmount: z.number().nonnegative().nullable().optional(),
  reason: z.string().trim().max(2000).default(''),
  scheduleImpact: z.string().trim().max(1000).optional(),
});

changeOrders.post(
  '/:id/transition',
  ah(async (req, res) => {
    const input = parseBody(coTransitionSchema, req.body);
    const actor = currentUser(req);
    const perm = CO_PERMISSIONS[input.to as ChangeOrderStatus];
    if (perm && !userCan(req, perm)) {
      throw forbidden(`Your role (${actor.role}) does not include "${perm}".`);
    }

    const db = getDb();
    const row = must(db.prepare('SELECT * FROM change_orders WHERE id = ?').get(req.params.id), 'Change order') as any;

    const internalAmount = input.internalAmount === undefined ? row.internal_amount : input.internalAmount;
    const customerAmount = input.customerAmount === undefined ? row.customer_amount : input.customerAmount;

    if (input.to === 'priced' && (internalAmount === null || internalAmount <= 0 || customerAmount === null || customerAmount <= 0)) {
      throw validationError('Priced change orders need a positive internal cost and customer price.', {
        internalAmount, customerAmount,
      });
    }

    const result = evaluateChangeOrderAdvance({
      from: row.status,
      to: input.to,
      internalAmount,
      customerAmount,
      hasScope: `${row.description ?? ''}${row.title ?? ''}`.trim().length >= 10,
      pricedByUnderwriting: row.priced_at != null,
      internallyApproved: row.internal_approved_at != null,
      // Moving TO customer_approved is the act of recording the customer's
      // decision (done by a closer holding changeorder.present); the gate
      // still requires it before `authorized` can pass.
      customerApproved:
        row.status === 'customer_approved' || row.status === 'authorized' || input.to === 'customer_approved',
    });
    if (!result.ok) {
      return res.status(409).json({
        error: {
          code: 'conflict',
          message: 'This change order cannot move to that stage yet.',
          details: { blockers: result.blockers },
        },
        blockers: result.blockers,
      });
    }

    const at = now();
    const patch: any = { status: input.to };
    if (input.to === 'priced') {
      patch.priced_at = at;
      patch.priced_by = actor.id;
      patch.internal_amount = round2(internalAmount!);
      patch.customer_amount = round2(customerAmount!);
    } else if (input.to === 'internal_approved') {
      patch.internal_approved_at = at;
      patch.internal_approved_by = actor.id;
    } else if (input.to === 'customer_presented') {
      patch.presented_at = at;
    } else if (input.to === 'customer_approved' || input.to === 'customer_rejected') {
      patch.customer_decided_at = at;
      patch.customer_decision_note = input.reason ?? '';
    } else if (input.to === 'authorized') {
      patch.authorized_at = at;
      patch.authorized_by = actor.id;
    }
    if (input.scheduleImpact !== undefined) patch.schedule_impact = input.scheduleImpact;

    tx((txdb) => {
      const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
      txdb
        .prepare(`UPDATE change_orders SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...patch, updated_at: at, id: row.id });

      // CRITICAL: an authorized CO changes what the project is worth —
      // refresh the parent rollup in the same transaction.
      if (input.to === 'authorized') {
        const total = (
          txdb
            .prepare(
              `SELECT COALESCE(SUM(customer_amount), 0) AS n FROM change_orders
                WHERE project_id = ? AND status = 'authorized'`,
            )
            .get(row.project_id) as any
        ).n;
        const project = txdb.prepare('SELECT change_order_total FROM projects WHERE id = ?').get(row.project_id) as any;
        txdb
          .prepare('UPDATE projects SET change_order_total = ?, updated_at = ? WHERE id = ?')
          .run(round2(total), at, row.project_id);
        audit({
          actorId: actor.id, actorName: actor.name, action: 'project.change_order_total_updated',
          entityType: 'project', entityId: row.project_id,
          summary: `Change-order total is now ${round2(total)} after ${row.co_no} was authorized`,
          before: { change_order_total: project?.change_order_total ?? 0 },
          after: { change_order_total: round2(total) },
        });
      }
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'change_order.status_changed',
      entityType: 'change_order', entityId: row.id,
      summary: `${row.co_no} moved from ${row.status} to ${input.to}`,
      before: { status: row.status }, after: { status: input.to },
      meta: { amount: customerAmount ?? null },
    });
    res.json({ row: db.prepare('SELECT * FROM change_orders WHERE id = ?').get(row.id) });
  }),
);

/* ================================================================== */
/* Invoices                                                           */
/* ================================================================== */

export const invoices = Router();
invoices.use(requireAuth);

invoices.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const projectId = String((req.query as any).projectId ?? '').trim();
    const status = String((req.query as any).status ?? '').trim();
    const overdue = (req.query as any).overdue === '1';

    const where: string[] = [];
    const params: any[] = [];
    if (projectId) { where.push('i.project_id = ?'); params.push(projectId); }
    if (status) { where.push('i.status = ?'); params.push(status); }
    if (overdue) {
      where.push(`i.due_at IS NOT NULL AND i.due_at < ? AND i.status IN ('sent', 'partial')`);
      params.push(now());
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM invoices i ${clause}`).get(...params) as any
    ).n;
    const rows = getDb()
      .prepare(
        `SELECT i.*, p.name AS project_name,
                COALESCE((SELECT SUM(pm.amount) FROM payments pm WHERE pm.invoice_id = i.id), 0) AS collected,
                i.amount - COALESCE((SELECT SUM(pm.amount) FROM payments pm WHERE pm.invoice_id = i.id), 0) AS balance
           FROM invoices i JOIN projects p ON p.id = i.project_id
          ${clause}
          ORDER BY i.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const createInvoiceSchema = z.object({
  projectId: z.string().trim().min(1),
  jobId: z.string().trim().min(1).nullish(),
  drawItemId: z.string().trim().min(1).nullish(),
  amount: z.number().positive(),
  issuedAt: z.number().int().positive().nullish(),
  dueAt: z.number().int().positive().nullish(),
  notes: z.string().trim().max(4000).default(''),
});

invoices.post(
  '/',
  requirePermission('invoice.manage'),
  ah(async (req, res) => {
    const input = parseBody(createInvoiceSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId), 'Project');
    if (input.jobId) {
      const job = must(db.prepare('SELECT id, project_id FROM jobs WHERE id = ?').get(input.jobId), 'Job') as any;
      if (job.project_id !== input.projectId) {
        throw badRequest('That job does not belong to the project.', { jobId: input.jobId });
      }
    }
    if (input.drawItemId) {
      const item = db
        .prepare(
          `SELECT di.id FROM draw_items di
             JOIN draw_schedules ds ON ds.id = di.schedule_id
            WHERE di.id = ? AND ds.project_id = ?`,
        )
        .get(input.drawItemId, input.projectId);
      if (!item) {
        throw badRequest('That draw item is not part of a schedule for this project.', {
          drawItemId: input.drawItemId,
        });
      }
    }

    const id = newId('inv');
    tx((txdb) => {
      // Sequential invoice_no: counted inside the transaction so it cannot race.
      const count = (txdb.prepare('SELECT COUNT(*) AS n FROM invoices').get() as any).n;
      const at = now();
      txdb
        .prepare(
          `INSERT INTO invoices (id, invoice_no, project_id, job_id, draw_item_id, amount, issued_at, due_at,
             status, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, formatNo('INV', count + 1), input.projectId, input.jobId ?? null, input.drawItemId ?? null,
          round2(input.amount), input.issuedAt ?? null, input.dueAt ?? null,
          input.issuedAt ? 'sent' : 'draft', input.notes, actor.id, at, at,
        );
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'invoice.created',
      entityType: 'invoice', entityId: id,
      summary: `Created invoice for ${round2(input.amount)}`,
      after: { projectId: input.projectId, amount: round2(input.amount) },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) });
  }),
);

invoices.post(
  '/:id/issue',
  requirePermission('invoice.manage'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Invoice not found.');
    const issuedAt = before.issued_at ?? now();
    const dueAt = before.due_at ?? issuedAt + 30 * DAY_MS;
    db.prepare(
      `UPDATE invoices SET status = 'sent', issued_at = ?, due_at = ?, updated_at = ? WHERE id = ?`,
    ).run(issuedAt, dueAt, now(), req.params.id);

    const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'invoice.issued',
      entityType: 'invoice', entityId: req.params.id,
      summary: `Issued invoice ${before.invoice_no}`,
      before, after,
    });
    res.json({ row: after });
  }),
);

const paymentSchema = z.object({
  amount: z.number().positive(),
  receivedAt: z.number().int().positive().nullish(),
  method: z.string().trim().min(1).max(40).default('other'),
  reference: z.string().trim().max(200).default(''),
});

invoices.post(
  '/:id/payments',
  requirePermission('invoice.manage'),
  ah(async (req, res) => {
    const input = parseBody(paymentSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id) as any;
    if (!invoice) throw notFound('Invoice not found.');

    const collected = (
      db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE invoice_id = ?').get(invoice.id) as any
    ).n;
    const balance = round2(invoice.amount - collected);
    if (input.amount > balance + 0.004) {
      throw validationError('A payment cannot exceed the invoice balance.', {
        amount: round2(input.amount), balance,
      });
    }

    const id = newId('pmt');
    const at = now();
    const newCollected = round2(collected + input.amount);
    db.prepare(
      `INSERT INTO payments (id, invoice_id, project_id, amount, received_at, method, reference, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, invoice.id, invoice.project_id, round2(input.amount),
      input.receivedAt ?? at, input.method, input.reference, actor.id, at,
    );

    // Recompute status: fully collected → paid, otherwise partial.
    const status = newCollected >= invoice.amount - 0.004 ? 'paid' : 'partial';
    db.prepare('UPDATE invoices SET status = ?, collected_at = ?, updated_at = ? WHERE id = ?').run(
      status, status === 'paid' ? at : null, at, invoice.id,
    );

    audit({
      actorId: actor.id, actorName: actor.name, action: 'payment.recorded',
      entityType: 'payment', entityId: id,
      summary: `Recorded payment of ${round2(input.amount)} for ${invoice.invoice_no}`,
      meta: { invoiceId: invoice.id, amount: round2(input.amount), method: input.method },
    });
    const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'invoice.status_changed',
      entityType: 'invoice', entityId: invoice.id,
      summary: `${invoice.invoice_no} is now ${status}`,
      before: { status: invoice.status }, after: { status },
      meta: { collected: newCollected },
    });
    res.status(201).json({ payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(id), invoice: after });
  }),
);

invoices.delete(
  '/:id',
  requirePermission('invoice.manage'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Invoice not found.');
    const payments = (
      db.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?').get(before.id) as any
    ).n;
    if (payments > 0) {
      throw conflict('Payments have been recorded against this invoice; void it instead of deleting.', {
        payments,
      });
    }
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'invoice.removed',
      entityType: 'invoice', entityId: req.params.id,
      summary: `Removed invoice ${before.invoice_no}`, before,
    });
    res.json({ ok: true });
  }),
);

/* Mounted by the app as /api/projects, /api/jobs, /api/change-orders and
   /api/invoices respectively (see server/app.ts). */
export const productionRouter = { projects, jobs, changeOrders, invoices };
