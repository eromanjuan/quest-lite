import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser, userCan } from '../auth/middleware.js';
import { ah, parseBody, must, notFound, badRequest, conflict, parsePagination, page } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';
import { round2, num } from '../core/money.js';
import { allocateDraws } from '../domain/estimating/calc.js';
import { evaluateWonGate, type WonGateConfig } from '../domain/workflow/gates.js';

export const dealsRouter = Router();
dealsRouter.use(requireAuth);

/**
 * The first stage is `review`: Underwriting has released the quote and Sales
 * must check scope, exclusions and pricing before anything reaches the
 * customer (spec §6.2). Only after the closer sends it does it become
 * `estimate_sent`.
 */
const STAGES = [
  'review',
  'estimate_sent',
  'negotiating',
  'contract_sent',
  'waiting_to_sign',
  'won',
  'lost',
] as const;

const TRANSITIONS: Record<string, string[]> = {
  review: ['estimate_sent', 'lost'],
  estimate_sent: ['negotiating', 'contract_sent', 'lost'],
  negotiating: ['estimate_sent', 'contract_sent', 'lost'],
  contract_sent: ['waiting_to_sign', 'negotiating', 'lost'],
  waiting_to_sign: ['contract_sent', 'won', 'lost'],
  won: [],
  lost: ['review'],
};

function assertTransition(from: string, to: string) {
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw conflict(
      `A deal cannot move from "${from}" to "${to}". Allowed next stages: ${(allowed ?? []).join(', ') || 'none'}.`,
      { from, to, allowed: allowed ?? [] },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Review queue: released quotes waiting for Sales                    */
/* ------------------------------------------------------------------ */

dealsRouter.get(
  '/review-queue',
  ah(async (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT e.id AS estimate_id, e.version, e.status, e.calc, e.created_at,
                b.id AS bid_id, b.bid_no, b.trade, b.project_address, b.scope_summary,
                co.first_name || ' ' || co.last_name AS contact_name,
                c.name AS company_name, u.name AS estimator_name,
                d.id AS existing_deal_id
           FROM estimates e
           JOIN bids b ON b.id = e.bid_id
           JOIN contacts co ON co.id = b.contact_id
           LEFT JOIN companies c ON c.id = b.company_id
           LEFT JOIN users u ON u.id = b.estimator_id
           LEFT JOIN deals d ON d.bid_id = b.id
          WHERE e.status = 'released' AND d.id IS NULL AND b.archived_at IS NULL
          ORDER BY b.quote_due_at ASC NULLS LAST, b.started_at ASC`,
      )
      .all()
      .map((r: any) => ({ ...r, calc: JSON.parse(r.calc || '{}') }));
    res.json({ rows });
  }),
);

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

dealsRouter.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 100);
    const q = String((req.query as any).q ?? '').trim();
    const stage = String((req.query as any).stage ?? '');
    const closerId = String((req.query as any).closerId ?? '');

    const where: string[] = ['d.archived_at IS NULL'];
    const params: any[] = [];
    if (q) {
      where.push(
        `(d.project_name LIKE ? OR d.deal_no LIKE ? OR co.first_name LIKE ? OR co.last_name LIKE ? OR c.name LIKE ?)`,
      );
      for (let i = 0; i < 5; i++) params.push(`%${q}%`);
    }
    if (stage) { where.push('d.stage = ?'); params.push(stage); }
    if (closerId) { where.push('d.closer_id = ?'); params.push(closerId); }
    const clause = `WHERE ${where.join(' AND ')}`;

    const rows = getDb()
      .prepare(
        `SELECT d.*, co.first_name AS contact_first, co.last_name AS contact_last,
                co.phone, co.email, c.name AS company_name, u.name AS closer_name,
                b.bid_no, b.trade AS bid_trade,
                p.version AS proposal_version, p.status AS proposal_status,
                (SELECT COUNT(*) FROM tasks t WHERE t.deal_id = d.id AND t.status = 'open') AS open_tasks,
                (SELECT MAX(cm.occurred_at) FROM communications cm WHERE cm.deal_id = d.id) AS last_comm_at,
                (SELECT ct.signature_status FROM contracts ct WHERE ct.deal_id = d.id
                  ORDER BY ct.version DESC LIMIT 1) AS signature_status
           FROM deals d
           JOIN contacts co ON co.id = d.contact_id
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN users u ON u.id = d.closer_id
           LEFT JOIN bids b ON b.id = d.bid_id
           LEFT JOIN proposals p ON p.id = d.current_proposal_id
           ${clause}
          ORDER BY d.expected_close_at ASC NULLS LAST, d.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    const byStage = getDb()
      .prepare(
        `SELECT stage, COUNT(*) AS count, COALESCE(SUM(value), 0) AS value
           FROM deals WHERE archived_at IS NULL GROUP BY stage`,
      )
      .all();
    const totals = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }]));
    for (const r of byStage as any[]) totals[r.stage] = { count: r.count, value: round2(r.value) };

    res.json({ ...page(rows, rows.length, limit, offset), totals, stages: STAGES });
  }),
);

dealsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const deal = db
      .prepare(
        `SELECT d.*, co.first_name AS contact_first, co.last_name AS contact_last,
                co.phone, co.mobile, co.email, c.name AS company_name,
                u.name AS closer_name, b.bid_no, b.trade AS bid_trade, b.scope_summary
           FROM deals d
           JOIN contacts co ON co.id = d.contact_id
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN users u ON u.id = d.closer_id
           LEFT JOIN bids b ON b.id = d.bid_id
          WHERE d.id = ?`,
      )
      .get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');

    const proposals = db
      .prepare('SELECT * FROM proposals WHERE deal_id = ? ORDER BY version DESC')
      .all(req.params.id)
      .map((p: any) => ({
        ...p,
        options: JSON.parse(p.options || '[]'),
        scope_snapshot: JSON.parse(p.scope_snapshot || '{}'),
        estimate_snapshot: JSON.parse(p.estimate_snapshot || '{}'),
        attachments: JSON.parse(p.attachments || '[]'),
      }));

    const schedule = db
      .prepare(`SELECT * FROM draw_schedules WHERE deal_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .get(req.params.id) as any;
    const draws = schedule
      ? db.prepare('SELECT * FROM draw_items WHERE schedule_id = ? ORDER BY seq').all(schedule.id)
      : [];

    const contracts = db.prepare('SELECT * FROM contracts WHERE deal_id = ? ORDER BY version DESC').all(req.params.id);
    const deposit = db.prepare('SELECT * FROM deposits WHERE deal_id = ?').get(req.params.id) ?? null;
    const compliance = db.prepare('SELECT * FROM compliance_items WHERE deal_id = ? ORDER BY name').all(req.params.id);
    const estimate = deal.bid_id
      ? (db
          .prepare(`SELECT * FROM estimates WHERE bid_id = ? AND status = 'released' ORDER BY version DESC LIMIT 1`)
          .get(deal.bid_id) as any)
      : null;
    if (estimate) {
      estimate.inputs = JSON.parse(estimate.inputs || '{}');
      estimate.calc = JSON.parse(estimate.calc || '{}');
    }
    const project = db.prepare('SELECT * FROM projects WHERE deal_id = ?').get(req.params.id) ?? null;
    const tasks = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id = t.assignee_id
          WHERE t.deal_id = ? AND t.status = 'open' ORDER BY t.due_at`,
      )
      .all(req.params.id);

    res.json({
      deal,
      proposals,
      drawSchedule: schedule ? { ...schedule, items: draws } : null,
      contracts,
      deposit,
      compliance,
      estimate,
      project,
      tasks,
      gate: await wonGateFor(req.params.id, req),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Create a deal from a released estimate                              */
/* ------------------------------------------------------------------ */

dealsRouter.post(
  '/from-estimate/:estimateId',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(req.params.estimateId) as any;
    if (!est) throw notFound('Estimate not found.');
    if (est.status !== 'released') throw conflict('Only a released quote can go to Sales.');

    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;
    const existing = db.prepare('SELECT id, deal_no FROM deals WHERE bid_id = ?').get(bid.id) as any;
    if (existing) {
      return res.status(409).json({
        error: { code: 'conflict', message: `This quote already has deal ${existing.deal_no}.` },
        deal: existing,
      });
    }

    const calc = JSON.parse(est.calc || '{}');
    const input = parseBody(
      z.object({
        projectName: z.string().trim().min(1).max(200).optional(),
        projectType: z.string().trim().max(60).default('standard'),
        closerId: z.string().nullish(),
        expectedCloseAt: z.number().nullish(),
      }),
      req.body ?? {},
    );

    const result = tx((t) => {
      const count = (t.prepare('SELECT COUNT(*) AS n FROM deals').get() as any).n;
      const id = newId('dl');
      const dealNo = `DEAL-${String(count + 1).padStart(4, '0')}`;
      t.prepare(
        `INSERT INTO deals (id, deal_no, opportunity_id, bid_id, contact_id, company_id, project_name,
           project_address, project_type, trade, value, closer_id, stage, expected_close_at,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?, ?, ?, ?)`,
      ).run(
        id, dealNo, bid.opportunity_id, bid.id, bid.contact_id, bid.company_id,
        input.projectName ?? bid.scope_summary.slice(0, 120) ?? bid.trade,
        bid.project_address, input.projectType, bid.trade,
        round2(num(calc.sellingPrice)), input.closerId ?? actor.id,
        input.expectedCloseAt ?? null, actor.id, now(), now(),
      );

      if (bid.opportunity_id) {
        t.prepare(`UPDATE opportunities SET stage='sales', updated_at=? WHERE id=?`).run(now(), bid.opportunity_id);
      }

      // Seed the standard compliance checklist from the project-type gate.
      const gate = t
        .prepare('SELECT * FROM won_gate_configs WHERE project_type = ?')
        .get(input.projectType) as any;
      const items: Array<[string, string, number]> = [
        ['insurance', 'Certificate of insurance', gate?.require_insurance ?? 1],
        ['w9', 'W-9', gate?.require_compliance ?? 1],
        ['license', 'Contractor licence', gate?.require_compliance ?? 1],
        ['lien_waiver', 'Lien waiver', 0],
      ];
      for (const [key, name, required] of items) {
        t.prepare(
          `INSERT INTO compliance_items (id, deal_id, key, name, required, received, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        ).run(newId('cmp'), id, key, name, required, now());
      }
      return { id, dealNo };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'deal.created',
      entityType: 'deal', entityId: result.id,
      summary: `${result.dealNo} opened from ${bid.bid_no} quote v${est.version}`,
      meta: { fromEstimate: est.id, value: calc.sellingPrice },
    });
    res.status(201).json({ deal: db.prepare('SELECT * FROM deals WHERE id = ?').get(result.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* Stage movement                                                      */
/* ------------------------------------------------------------------ */

dealsRouter.post(
  '/:id/move',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(z.object({ stage: z.enum(STAGES), reason: z.string().max(500).optional() }), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Deal not found.');
    if (before.stage === input.stage) return res.json({ row: before, unchanged: true });
    assertTransition(before.stage, input.stage);

    if (input.stage === 'won') {
      // Won is never a free move — it always runs the gate.
      const gate = await wonGateFor(before.id, req);
      if (!gate.ok) {
        return res.status(422).json({
          error: {
            code: 'validation',
            message: 'This deal does not meet its Won requirements yet.',
            details: { checks: gate.checks },
          },
          gate,
        });
      }
    }

    const dbx = getDb();
    const stamp: Record<string, string> = {
      estimate_sent: 'quote_sent_at',
      won: 'won_at',
      lost: 'lost_at',
    };
    const nowTs = now();
    const updates: string[] = ['stage = ?', 'updated_at = ?'];
    const values: any[] = [input.stage, nowTs];
    if (stamp[input.stage]) {
      updates.push(`${stamp[input.stage]} = COALESCE(${stamp[input.stage]}, ?)`);
      values.push(nowTs);
    }
    if (input.stage === 'lost') {
      updates.push('lost_reason = ?');
      values.push(input.reason ?? 'Not specified');
    }
    values.push(req.params.id);
    dbx.prepare(`UPDATE deals SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    audit({
      actorId: actor.id, actorName: actor.name, action: 'deal.stage_changed',
      entityType: 'deal', entityId: req.params.id,
      summary: `Moved ${before.stage} → ${input.stage}`,
      before: { stage: before.stage }, after: { stage: input.stage, reason: input.reason },
    });
    res.json({ row: db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) });
  }),
);

/** Send a quote back to Underwriting for re-pricing (closers cannot edit price). */
dealsRouter.post(
  '/:id/request-repricing',
  requirePermission('deal.request_repricing'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({ reason: z.string().trim().min(5).max(2000) }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');

    db.prepare(
      `UPDATE estimates SET status = 'draft', released_at = NULL, released_by = NULL, updated_at = ?
        WHERE bid_id = ? AND status = 'released'`,
    ).run(now(), deal.bid_id);
    db.prepare(`UPDATE bids SET stage = 'uw_sheet', released_at = NULL, updated_at = ? WHERE id = ?`).run(
      now(),
      deal.bid_id,
    );

    audit({
      actorId: actor.id, actorName: actor.name, action: 'deal.repricing_requested',
      entityType: 'deal', entityId: deal.id,
      summary: `Sent ${deal.deal_no} back to Underwriting for re-pricing`,
      after: { reason: input.reason },
    });
    res.json({ ok: true, note: 'The quote is back with Underwriting and can no longer be presented to the customer.' });
  }),
);

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

const proposalSchema = z.object({
  title: z.string().trim().max(200).default('Proposal'),
  pricingMode: z.enum(['lump', 'by_trade']).default('lump'),
  options: z
    .array(z.object({ key: z.string().max(40), label: z.string().max(120), price: z.number().finite().min(0), scope: z.string().max(8000).default('') }))
    .max(10)
    .default([]),
  selectedOption: z.string().nullish(),
  subtotal: z.number().finite().min(0).default(0),
  total: z.number().finite().min(0),
  paymentTerms: z.string().max(4000).default(''),
  validDays: z.number().int().min(1).max(365).default(30),
});

dealsRouter.post(
  '/:id/proposals',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(proposalSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');

    const estimate = db
      .prepare(`SELECT * FROM estimates WHERE bid_id = ? AND status = 'released' ORDER BY version DESC LIMIT 1`)
      .get(deal.bid_id) as any;
    if (!estimate) throw conflict('There is no released quote to build a proposal from.');
    const estInputs = JSON.parse(estimate.inputs || '{}');
    const estCalc = JSON.parse(estimate.calc || '{}');

    const result = tx((t) => {
      // Every prior proposal is superseded — a sent version is never mutated.
      t.prepare(
        `UPDATE proposals SET status = 'superseded', updated_at = ? WHERE deal_id = ? AND status IN ('draft','sent')`,
      ).run(now(), deal.id);
      const nextVersion =
        ((t.prepare('SELECT MAX(version) AS v FROM proposals WHERE deal_id = ?').get(deal.id) as any)?.v ?? 0) + 1;
      const id = newId('prp');
      t.prepare(
        `INSERT INTO proposals (id, deal_id, version, status, title, pricing_mode, options, selected_option,
           subtotal, total, payment_terms, valid_days, scope_snapshot, estimate_snapshot, recipient_contact_id,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, deal.id, nextVersion, input.title, input.pricingMode, JSON.stringify(input.options),
        input.selectedOption ?? null, input.subtotal, input.total, input.paymentTerms, input.validDays,
        JSON.stringify({ scopeText: estInputs.scopeText ?? '', exclusionsText: estInputs.exclusionsText ?? '' }),
        JSON.stringify({ estimateId: estimate.id, version: estimate.version, calc: estCalc }),
        deal.contact_id, actor.id, now(), now(),
      );
      t.prepare('UPDATE deals SET current_proposal_id = ?, updated_at = ? WHERE id = ?').run(id, now(), deal.id);
      return { id, version: nextVersion };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'proposal.created',
      entityType: 'proposal', entityId: result.id,
      summary: `Built proposal v${result.version} for ${deal.deal_no}`,
      after: { total: input.total, pricingMode: input.pricingMode },
    });
    res.status(201).json({ proposal: db.prepare('SELECT * FROM proposals WHERE id = ?').get(result.id) });
  }),
);

dealsRouter.post(
  '/proposals/:id/send',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({
        deliveryMethod: z.enum(['email', 'in_person', 'portal', 'other']),
        recipientContactId: z.string().optional(),
        note: z.string().max(1000).optional(),
        followUpAt: z.number().nullish(),
      }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id) as any;
    if (!p) throw notFound('Proposal not found.');
    if (p.status === 'sent') throw conflict('This proposal version has already been sent.');
    if (p.status === 'superseded') throw conflict('This proposal was superseded by a newer version.');

    const nowTs = now();
    db.prepare(
      `UPDATE proposals SET status='sent', delivery_method=?, recipient_contact_id=?, sent_at=?, updated_at=? WHERE id=?`,
    ).run(input.deliveryMethod, input.recipientContactId ?? p.recipient_contact_id, nowTs, nowTs, p.id);

    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(p.deal_id) as any;
    db.prepare(
      `UPDATE deals SET quote_sent_at = COALESCE(quote_sent_at, ?), last_contact_at = ?, updated_at = ?,
         stage = CASE WHEN stage IN ('review','estimate_sent','negotiating') THEN 'estimate_sent' ELSE stage END
       WHERE id = ?`,
    ).run(nowTs, nowTs, nowTs, p.deal_id);

    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, body, deal_id, contact_id,
         logged_by, occurred_at, created_at)
       VALUES (?, 'email', 'outbound', 'logged', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('cmm'),
      `Proposal v${p.version} sent — ${p.title}`,
      input.note ?? `Delivered by ${input.deliveryMethod}.`,
      p.deal_id, p.recipient_contact_id ?? deal.contact_id, actor.id, nowTs, nowTs,
    );

    if (input.followUpAt) {
      db.prepare(
        `INSERT INTO tasks (id, title, notes, type, assignee_id, due_at, contact_id, deal_id, created_by, created_at, updated_at)
         VALUES (?, ?, 'Proposal follow-up', 'follow_up', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('tsk'), `Follow up on proposal v${p.version} — ${deal.project_name}`,
        actor.id, input.followUpAt, deal.contact_id, p.deal_id, actor.id, nowTs, nowTs,
      );
    }

    audit({
      actorId: actor.id, actorName: actor.name, action: 'proposal.sent',
      entityType: 'proposal', entityId: p.id,
      summary: `Sent proposal v${p.version} by ${input.deliveryMethod}`,
      meta: { dealId: p.deal_id, deliveryMethod: input.deliveryMethod },
    });
    res.json({ proposal: db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* Draw schedule                                                       */
/* ------------------------------------------------------------------ */

const drawsSchema = z.object({
  items: z
    .array(
      z.object({
        milestone: z.string().trim().min(1).max(160),
        trigger: z.string().trim().max(300).default(''),
        pct: z.number().finite().min(0).max(100),
        description: z.string().max(1000).default(''),
        condition: z.string().max(300).default(''),
      }),
    )
    .min(1)
    .max(30),
});

dealsRouter.put(
  '/:id/draw-schedule',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(drawsSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');

    const contractValue = round2(deal.value);
    let amounts: number[];
    try {
      amounts = allocateDraws(contractValue, input.items);
    } catch (err: any) {
      // Percentages that do not total 100% are never persisted.
      return res.status(422).json({
        error: { code: 'validation', message: err.message, details: err.details ?? null },
      });
    }

    const result = tx((t) => {
      const prior = t
        .prepare(`SELECT id FROM draw_schedules WHERE deal_id = ? AND status = 'active'`)
        .get(deal.id) as any;
      if (prior) {
        t.prepare(`UPDATE draw_schedules SET status='superseded', updated_at=? WHERE id=?`).run(now(), prior.id);
      }
      const scheduleId = newId('drw');
      const version = ((t.prepare('SELECT MAX(version) AS v FROM draw_schedules WHERE deal_id = ?').get(deal.id) as any)?.v ?? 0) + 1;
      t.prepare(
        `INSERT INTO draw_schedules (id, deal_id, version, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      ).run(scheduleId, deal.id, version, actor.id, now(), now());

      const ins = t.prepare(
        `INSERT INTO draw_items (id, schedule_id, seq, milestone, trigger, pct, amount, description, condition, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.items.forEach((it, i) => {
        ins.run(newId('dri'), scheduleId, i + 1, it.milestone, it.trigger, round2(it.pct), amounts[i], it.description, it.condition, now());
      });
      return { scheduleId, version, total: amounts.reduce((a, b) => round2(a + b), 0) };
    });

    const sumPct = round2(input.items.reduce((a, b) => a + b.pct, 0));
    audit({
      actorId: actor.id, actorName: actor.name, action: 'draw_schedule.saved',
      entityType: 'deal', entityId: deal.id,
      summary: `Saved draw schedule v${result.version} (${sumPct}% across ${input.items.length} draws)`,
      after: { contractValue, sumPct, total: result.total },
    });
    res.json({
      schedule: db.prepare('SELECT * FROM draw_schedules WHERE id = ?').get(result.scheduleId),
      items: db.prepare('SELECT * FROM draw_items WHERE schedule_id = ? ORDER BY seq').all(result.scheduleId),
      total: result.total,
      sumPct,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Contracts, deposits, compliance                                     */
/* ------------------------------------------------------------------ */

dealsRouter.post(
  '/:id/contract',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({ amount: z.number().finite().min(0), version: z.number().int().min(1).default(1) }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');
    const clash = db.prepare('SELECT id FROM contracts WHERE deal_id = ? AND version = ?').get(deal.id, input.version);
    if (clash) throw conflict(`Contract version ${input.version} already exists.`);

    const id = newId('ctr');
    db.prepare(
      `INSERT INTO contracts (id, deal_id, version, amount, status, signature_status, provider, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 'unsigned', 'none', ?, ?, ?)`,
    ).run(id, deal.id, input.version, round2(input.amount), actor.id, now(), now());

    audit({
      actorId: actor.id, actorName: actor.name, action: 'contract.created',
      entityType: 'contract', entityId: id,
      summary: `Created contract v${input.version} for ${deal.deal_no}`,
      after: { amount: input.amount },
    });
    res.status(201).json({ contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) });
  }),
);

dealsRouter.post(
  '/contracts/:id/sign',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({
        signed: z.boolean().default(true),
        signatureRef: z.string().max(200).optional(),
        provider: z.string().max(60).optional(),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id) as any;
    if (!c) throw notFound('Contract not found.');

    const nowTs = now();
    db.prepare(
      `UPDATE contracts SET signature_status=?, status=?, signature_ref=?, provider=?, signed_at=?, updated_at=? WHERE id=?`,
    ).run(
      input.signed ? 'signed' : 'declined',
      input.signed ? 'signed' : 'sent',
      input.signatureRef ?? c.signature_ref,
      input.provider ?? c.provider,
      input.signed ? nowTs : null,
      nowTs,
      c.id,
    );
    if (input.signed) {
      db.prepare(`UPDATE deals SET stage = 'waiting_to_sign', updated_at = ? WHERE id = ? AND stage NOT IN ('won','lost')`).run(
        nowTs,
        c.deal_id,
      );
    }

    audit({
      actorId: actor.id, actorName: actor.name, action: input.signed ? 'contract.signed' : 'contract.declined',
      entityType: 'contract', entityId: c.id,
      summary: `${input.signed ? 'Signed' : 'Declined'} contract v${c.version} (${c.amount})`,
      before: { signature_status: c.signature_status },
      after: { signature_status: input.signed ? 'signed' : 'declined', provider: input.provider ?? c.provider },
      meta: { esignConfigured: Boolean(process.env.ESIGN_API_KEY && process.env.ESIGN_PROVIDER) },
    });
    res.json({ contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(c.id) });
  }),
);

dealsRouter.put(
  '/:id/deposit',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({
        amount: z.number().finite().min(0).default(0),
        status: z.enum(['not_required', 'due', 'received', 'cleared']),
        dueAt: z.number().nullish(),
        method: z.string().max(40).nullish(),
        reference: z.string().max(120).nullish(),
      }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');

    const nowTs = now();
    const existing = db.prepare('SELECT * FROM deposits WHERE deal_id = ?').get(deal.id) as any;
    const received = input.status === 'received' || input.status === 'cleared';
    const cleared = input.status === 'cleared';

    if (existing) {
      db.prepare(
        `UPDATE deposits SET amount=?, status=?, due_at=?, received_at=COALESCE(received_at, ?), cleared_at=COALESCE(cleared_at, ?),
           method=COALESCE(?, method), reference=COALESCE(?, reference), updated_at=? WHERE id=?`,
      ).run(
        round2(input.amount), input.status, input.dueAt ?? existing.due_at,
        received ? nowTs : null, cleared ? nowTs : null,
        input.method ?? null, input.reference ?? null, nowTs, existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO deposits (id, deal_id, amount, due_at, status, received_at, cleared_at, method, reference, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('dep'), deal.id, round2(input.amount), input.dueAt ?? null, input.status,
        received ? nowTs : null, cleared ? nowTs : null,
        input.method ?? null, input.reference ?? null, actor.id, nowTs, nowTs,
      );
    }

    audit({
      actorId: actor.id, actorName: actor.name, action: 'deposit.updated',
      entityType: 'deal', entityId: deal.id,
      summary: `Deposit for ${deal.deal_no}: ${input.status} (${input.amount})`,
      before: existing ? { status: existing.status, amount: existing.amount } : null,
      after: { status: input.status, amount: input.amount, method: input.method },
    });
    res.json({ deposit: db.prepare('SELECT * FROM deposits WHERE deal_id = ?').get(deal.id) });
  }),
);

dealsRouter.post(
  '/:id/compliance/:key',
  requirePermission('deal.write'),
  ah(async (req, res) => {
    const input = parseBody(z.object({ received: z.boolean(), documentId: z.string().nullish() }), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM compliance_items WHERE deal_id = ? AND key = ?')
      .get(req.params.id, req.params.key) as any;
    if (!row) throw notFound('Compliance item not found.');

    db.prepare(
      `UPDATE compliance_items SET received=?, document_id=COALESCE(?, document_id),
         received_at=CASE WHEN ? = 1 THEN COALESCE(received_at, ?) ELSE NULL END, updated_at=? WHERE id=?`,
    ).run(input.received ? 1 : 0, input.documentId ?? null, input.received ? 1 : 0, now(), now(), row.id);

    audit({
      actorId: actor.id, actorName: actor.name,
      action: input.received ? 'compliance.received' : 'compliance.cleared',
      entityType: 'deal', entityId: req.params.id,
      summary: `${row.name}: ${input.received ? 'received' : 'cleared'}`,
      before: { received: row.received }, after: { received: input.received ? 1 : 0 },
    });
    res.json({ item: db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(row.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* The Won gate                                                        */
/* ------------------------------------------------------------------ */

async function wonGateFor(dealId: string, req: any) {
  const db = getDb();
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) throw notFound('Deal not found.');

  const config = (db
    .prepare('SELECT * FROM won_gate_configs WHERE project_type = ?')
    .get(deal.project_type) ?? db.prepare(`SELECT * FROM won_gate_configs WHERE project_type = 'standard'`).get()) as any;

  const contracts = db.prepare('SELECT * FROM contracts WHERE deal_id = ?').all(dealId) as any[];
  const deposit = db.prepare('SELECT * FROM deposits WHERE deal_id = ?').get(dealId) as any;
  const compliance = db.prepare('SELECT * FROM compliance_items WHERE deal_id = ?').all(dealId) as any[];
  const released = db
    .prepare(`SELECT COUNT(*) AS n FROM estimates WHERE bid_id = ? AND status = 'released'`)
    .get(deal.bid_id) as any;
  const pendingApprovals = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM margin_approvals m JOIN estimates e ON e.id = m.estimate_id
        WHERE e.bid_id = ? AND m.status = 'pending'`,
    )
    .get(deal.bid_id) as any).n;

  const gateConfig: WonGateConfig = config ?? {
    require_contract_signed: 1, require_deposit: 1, require_insurance: 1,
    require_compliance: 1, require_approval: 1,
  };

  return evaluateWonGate(gateConfig, {
    hasSignedContract: contracts.some((c) => c.signature_status === 'signed'),
    depositStatus: deposit?.status ?? 'not_required',
    complianceItems: compliance.map((c) => ({ key: c.key, name: c.name, required: c.required, received: c.received })),
    pendingInternalApprovals: pendingApprovals,
    hasReleasedQuote: released.n > 0,
  });
}

dealsRouter.get(
  '/:id/won-gate',
  ah(async (req, res) => {
    res.json(await wonGateFor(req.params.id, req));
  }),
);

/* ------------------------------------------------------------------ */
/* Won → Production handoff (idempotent)                               */
/* ------------------------------------------------------------------ */

dealsRouter.post(
  '/:id/won',
  requirePermission('deal.mark_won'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');
    if (deal.stage === 'won' || deal.handoff_project_id) {
      const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(deal.handoff_project_id);
      if (existing) {
        return res.json({ alreadyHandedOff: true, project: existing, note: 'Handoff is idempotent — no duplicates were created.' });
      }
    }
    if (deal.stage === 'lost') throw conflict('A lost deal cannot be won.');

    const gate = await wonGateFor(deal.id, req);
    if (!gate.ok) {
      return res.status(422).json({
        error: {
          code: 'validation',
          message: 'This deal does not meet its Won requirements yet.',
          details: { checks: gate.checks.filter((c) => c.required && !c.passed) },
        },
        gate,
      });
    }

    const handoff = tx((t) => {
      // Belt and braces: never create a second project for the same deal.
      const dup = t.prepare('SELECT * FROM projects WHERE deal_id = ?').get(deal.id) as any;
      if (dup) return { projectId: dup.id, projectNo: dup.project_no, created: false };

      const count = (t.prepare('SELECT COUNT(*) AS n FROM projects').get() as any).n;
      const projectId = newId('prj');
      const projectNo = `PRJ-${String(count + 1).padStart(4, '0')}`;

      t.prepare(
        `INSERT INTO projects (id, project_no, deal_id, opportunity_id, contact_id, company_id, name, address,
           project_type, status, original_contract, change_order_total, started_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`,
      ).run(
        projectId, projectNo, deal.id, deal.opportunity_id, deal.contact_id, deal.company_id,
        deal.project_name, deal.project_address, deal.project_type,
        round2(deal.value), now(), actor.id, now(), now(),
      );

      // One job per trade across every released bid on the same opportunity.
      const trades = t
        .prepare(
          `SELECT DISTINCT b.id, b.trade, b.scope_summary, b.id AS bid_id FROM bids b
            WHERE b.id = ? OR (b.opportunity_id IS NOT NULL AND b.opportunity_id = ?)
            ORDER BY b.started_at`,
        )
        .all(deal.bid_id, deal.opportunity_id) as any[];

      const jobTradeSet = new Set<string>();
      for (const b of trades) {
        if (!b.trade || jobTradeSet.has(b.trade)) continue;
        jobTradeSet.add(b.trade);

        const releasedEstimate = t
          .prepare(`SELECT * FROM estimates WHERE bid_id = ? AND status='released' ORDER BY version DESC LIMIT 1`)
          .get(b.id) as any;
        let estimatedCost = 0;
        let scopeSnapshot: any = {};
        if (releasedEstimate) {
          const calc = JSON.parse(releasedEstimate.calc || '{}');
          estimatedCost = round2(num(calc.hardCost));
          const inputs = JSON.parse(releasedEstimate.inputs || '{}');
          scopeSnapshot = {
            estimateId: releasedEstimate.id,
            estimateVersion: releasedEstimate.version,
            scopeText: inputs.scopeText ?? '',
            exclusionsText: inputs.exclusionsText ?? '',
            sellLines: inputs.sellLines ?? [],
            costLines: inputs.costLines ?? [],
            taxRate: inputs.taxRate,
            commissionPct: inputs.commissionPct,
          };
        }

        const jobCount = (t.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n;
        const jobId = newId('job');
        t.prepare(
          `INSERT INTO jobs (id, job_no, project_id, trade, name, stage, scope_snapshot, estimated_cost,
             stage_entered_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'unscheduled', ?, ?, ?, ?, ?, ?)`,
        ).run(
          jobId, `JOB-${String(jobCount + 1).padStart(4, '0')}`, projectId, b.trade,
          b.scope_summary.slice(0, 120) || b.trade, JSON.stringify(scopeSnapshot),
          estimatedCost, now(), actor.id, now(), now(),
        );
      }

      // The draw schedule carries forward onto the project.
      const schedule = t
        .prepare(`SELECT * FROM draw_schedules WHERE deal_id = ? AND status='active'`)
        .get(deal.id) as any;
      if (schedule) {
        const items = t.prepare('SELECT * FROM draw_items WHERE schedule_id = ? ORDER BY seq').all(schedule.id) as any[];
        const projectScheduleId = newId('drw');
        t.prepare(
          `INSERT INTO draw_schedules (id, project_id, version, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        ).run(projectScheduleId, projectId, schedule.version, actor.id, now(), now());
        const ins = t.prepare(
          `INSERT INTO draw_items (id, schedule_id, seq, milestone, trigger, pct, amount, description, condition, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const it of items) {
          ins.run(newId('dri'), projectScheduleId, it.seq, it.milestone, it.trigger, it.pct, it.amount, it.description, it.condition, now());
        }
      }

      t.prepare(
        `UPDATE deals SET stage='won', won_at=COALESCE(won_at, ?), handoff_at=?, handoff_project_id=?, updated_at=? WHERE id=?`,
      ).run(now(), now(), projectId, now(), deal.id);

      if (deal.opportunity_id) {
        t.prepare(`UPDATE opportunities SET stage='production', updated_at=? WHERE id=?`).run(now(), deal.opportunity_id);
      }

      return { projectId, projectNo, created: true };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'deal.won',
      entityType: 'deal', entityId: deal.id,
      summary: `${deal.deal_no} marked Won → ${handoff.projectNo}`,
      before: { stage: deal.stage }, after: { stage: 'won', projectId: handoff.projectId },
      meta: { gateChecks: gate.checks.filter((c) => c.required).length },
    });
    if (handoff.created) {
      audit({
        actorId: actor.id, actorName: actor.name, action: 'project.handoff',
        entityType: 'project', entityId: handoff.projectId,
        summary: `Handoff from ${deal.deal_no} created ${handoff.projectNo}`,
        meta: { dealId: deal.id, idempotent: true },
      });
    }

    res.json({
      ok: true,
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(handoff.projectId),
      jobs: db.prepare('SELECT * FROM jobs WHERE project_id = ?').all(handoff.projectId),
      created: handoff.created,
    });
  }),
);

/** Re-running the handoff must never duplicate projects, jobs or money records. */
dealsRouter.post(
  '/:id/handoff',
  requirePermission('deal.mark_won'),
  ah(async (req, res) => {
    const deal = getDb().prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id) as any;
    if (!deal) throw notFound('Deal not found.');
    if (deal.handoff_project_id) {
      const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(deal.handoff_project_id);
      if (project) {
        return res.json({
          alreadyHandedOff: true,
          project,
          jobs: getDb().prepare('SELECT * FROM jobs WHERE project_id = ?').all(deal.handoff_project_id),
          note: 'Repeating the handoff created no duplicate records.',
        });
      }
    }
    // Fall through to the same gate-checked path.
    return res.status(409).json({
      error: { code: 'conflict', message: 'This deal has not been marked Won yet. Use the Won action.' },
    });
  }),
);
