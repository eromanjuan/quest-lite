import { Router } from 'express';
import { z } from 'zod';
import { getDb, now } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, parsePagination, page } from '../http/helpers.js';
import { badRequest, conflict } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const taskTypeSchema = z.enum([
  'follow_up',
  'call',
  'text',
  'email',
  'site_visit',
  'document',
  'task',
]);
const taskStatusSchema = z.enum(['open', 'done', 'cancelled']);

const DAY_MS = 86_400_000;

/** Epoch-ms query param; absent, blank or invalid values come back undefined. */
function msParam(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function strParam(value: unknown): string {
  return String(value ?? '').trim();
}

function startOfToday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function mustAssignee(db: ReturnType<typeof getDb>, assigneeId: string): void {
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(assigneeId)) {
    throw badRequest('That assignee is not a valid user.', { field: 'assigneeId' });
  }
}

/* ================================================================== */
/* Reads                                                              */
/* ================================================================== */

tasksRouter.get(
  '/',
  requirePermission('task.read'),
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req);
    const query = req.query as any;
    const status = strParam(query.status) || 'open';

    const where: string[] = [];
    const params: any[] = [];
    if (status && status !== 'all') {
      where.push('t.status = ?');
      params.push(status);
    }
    const assignee = strParam(query.assignee);
    if (assignee) {
      where.push('t.assignee_id = ?');
      params.push(assignee);
    }
    const links = [
      ['contactId', 't.contact_id'],
      ['prospectId', 't.prospect_id'],
      ['bidId', 't.bid_id'],
      ['dealId', 't.deal_id'],
      ['projectId', 't.project_id'],
      ['jobId', 't.job_id'],
      ['type', 't.type'],
    ] as const;
    for (const [key, column] of links) {
      const value = strParam(query[key]);
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    const from = msParam(query.from);
    if (from !== undefined) {
      where.push('t.due_at >= ?');
      params.push(from);
    }
    const to = msParam(query.to);
    if (to !== undefined) {
      where.push('t.due_at <= ?');
      params.push(to);
    }
    const search = strParam(query.q);
    if (search) {
      where.push('t.title LIKE ?');
      params.push(`%${search}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = getDb();
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM tasks t ${clause}`).get(...params) as any
    ).n;
    const rows = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
           ${clause}
          ORDER BY t.due_at ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

tasksRouter.get(
  '/calendar',
  requirePermission('task.read'),
  ah(async (req, res) => {
    const query = req.query as any;
    const nowMs = now();
    const from = msParam(query.from) ?? nowMs - 30 * DAY_MS;
    const to = msParam(query.to) ?? nowMs + 90 * DAY_MS;
    const status = strParam(query.status) || 'open';
    const assignee = strParam(query.assignee);

    const where = ['t.due_at >= ?', 't.due_at <= ?'];
    const params: any[] = [from, to];
    if (status && status !== 'all') {
      where.push('t.status = ?');
      params.push(status);
    }
    if (assignee) {
      where.push('t.assignee_id = ?');
      params.push(assignee);
    }

    const rows = getDb()
      .prepare(
        `SELECT t.*, u.name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.due_at ASC`,
      )
      .all(...params) as any[];

    const todayStart = startOfToday(nowMs);
    const tomorrowStart = todayStart + DAY_MS;
    const open = rows.filter((r) => r.status === 'open');
    const overdue = open.filter((r) => r.due_at < nowMs);
    const dueToday = open.filter(
      (r) => r.due_at >= todayStart && r.due_at < tomorrowStart,
    );
    res.json({
      rows,
      overdue,
      counts: {
        open: open.length,
        overdue: overdue.length,
        dueToday: dueToday.length,
      },
    });
  }),
);

/**
 * Phone-first queue: only open call/follow-up tasks on a contact we can
 * actually dial, bucketed by urgency so the rep can work top-down.
 */
tasksRouter.get(
  '/call-queue',
  requirePermission('task.read'),
  ah(async (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT t.id, t.title, t.notes, t.type, t.status, t.due_at, t.priority,
                t.assignee_id, t.contact_id, t.prospect_id,
                u.name AS assignee_name,
                co.first_name, co.last_name, co.phone, co.mobile, co.email,
                co.is_decision_maker, co.consent_sms,
                cmp.name AS company_name,
                (SELECT COUNT(*) FROM communications cm
                  WHERE cm.contact_id = t.contact_id AND cm.channel = 'call'
                ) AS prior_call_attempts,
                (SELECT CASE
                          WHEN cm.subject <> '' AND cm.body <> '' THEN cm.subject || ' — ' || cm.body
                          WHEN cm.body <> '' THEN cm.body
                          ELSE cm.subject
                        END
                   FROM communications cm
                  WHERE cm.contact_id = t.contact_id
                  ORDER BY cm.occurred_at DESC LIMIT 1
                ) AS last_communication_summary
           FROM tasks t
           JOIN contacts co ON co.id = t.contact_id
           LEFT JOIN companies cmp ON cmp.id = co.company_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.status = 'open'
            AND t.type IN ('call', 'follow_up')
            AND t.contact_id IS NOT NULL
            AND (COALESCE(co.phone, '') <> '' OR COALESCE(co.mobile, '') <> '')
          ORDER BY t.due_at ASC`,
      )
      .all() as any[];

    const nowMs = now();
    const todayStart = startOfToday(nowMs);
    const tomorrowStart = todayStart + DAY_MS;
    const counts = { overdue: 0, dueToday: 0, callbacks: 0, other: 0 };
    for (const row of rows) {
      // due_at is NOT NULL today, but a null would still be "everything else".
      const bucket =
        row.due_at == null ? 4 : row.due_at < todayStart ? 1 : row.due_at < tomorrowStart ? 2 : 3;
      row.priority_bucket = bucket;
      if (bucket === 1) counts.overdue += 1;
      else if (bucket === 2) counts.dueToday += 1;
      else if (bucket === 3) counts.callbacks += 1;
      else counts.other += 1;
    }
    rows.sort(
      (a, b) => a.priority_bucket - b.priority_bucket || (a.due_at ?? 0) - (b.due_at ?? 0),
    );
    res.json({ rows, counts });
  }),
);

/* ================================================================== */
/* Mutations                                                          */
/* ================================================================== */

const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000).default(''),
  type: taskTypeSchema.default('follow_up'),
  assigneeId: z.string().min(1),
  dueAt: z.number(),
  reminderAt: z.number().nullish(),
  priority: z.number().int().min(0).max(1).default(0),
  contactId: z.string().nullish(),
  prospectId: z.string().nullish(),
  opportunityId: z.string().nullish(),
  bidId: z.string().nullish(),
  dealId: z.string().nullish(),
  projectId: z.string().nullish(),
  jobId: z.string().nullish(),
});

tasksRouter.post(
  '/',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const input = parseBody(taskCreateSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    mustAssignee(db, input.assigneeId);

    const id = newId('tsk');
    const at = now();
    db.prepare(
      `INSERT INTO tasks
        (id, title, notes, type, assignee_id, due_at, reminder_at, status, priority,
         contact_id, prospect_id, opportunity_id, bid_id, deal_id, project_id, job_id,
         created_by, created_at, updated_at)
       VALUES
        (@id, @title, @notes, @type, @assignee_id, @due_at, @reminder_at, 'open', @priority,
         @contact_id, @prospect_id, @opportunity_id, @bid_id, @deal_id, @project_id, @job_id,
         @created_by, @created_at, @updated_at)`,
    ).run({
      id,
      title: input.title,
      notes: input.notes,
      type: input.type,
      assignee_id: input.assigneeId,
      due_at: input.dueAt,
      reminder_at: input.reminderAt ?? null,
      priority: input.priority,
      contact_id: input.contactId ?? null,
      prospect_id: input.prospectId ?? null,
      opportunity_id: input.opportunityId ?? null,
      bid_id: input.bidId ?? null,
      deal_id: input.dealId ?? null,
      project_id: input.projectId ?? null,
      job_id: input.jobId ?? null,
      created_by: actor.id,
      created_at: at,
      updated_at: at,
    });
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.created',
      entityType: 'task',
      entityId: id,
      summary: `Created task "${input.title}"`,
      after: input,
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) });
  }),
);

const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  type: taskTypeSchema.optional(),
  assigneeId: z.string().min(1).optional(),
  dueAt: z.number().optional(),
  reminderAt: z.number().nullish(),
  priority: z.number().int().min(0).max(1).optional(),
  status: taskStatusSchema.optional(),
});

tasksRouter.patch(
  '/:id',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const input = parseBody(taskPatchSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as any,
      'Task',
    );
    if (input.assigneeId && input.assigneeId !== before.assignee_id) {
      mustAssignee(db, input.assigneeId);
    }

    const patch: any = {
      title: input.title ?? before.title,
      notes: input.notes ?? before.notes,
      type: input.type ?? before.type,
      assignee_id: input.assigneeId ?? before.assignee_id,
      due_at: input.dueAt ?? before.due_at,
      reminder_at: input.reminderAt === undefined ? before.reminder_at : input.reminderAt,
      priority: input.priority ?? before.priority,
      status: input.status ?? before.status,
    };
    db.prepare(
      `UPDATE tasks SET
         title = @title, notes = @notes, type = @type, assignee_id = @assignee_id,
         due_at = @due_at, reminder_at = @reminder_at, priority = @priority,
         status = @status, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.updated',
      entityType: 'task',
      entityId: req.params.id,
      summary: `Updated task "${before.title}"`,
      before,
      after: patch,
    });
    res.json({ row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
  }),
);

const completionSchema = z.object({
  completion_note: z.string().trim().max(2000).optional(),
  completionNote: z.string().trim().max(2000).optional(),
});

tasksRouter.post(
  '/:id/complete',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const input = parseBody(completionSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as any,
      'Task',
    );
    const note = (input.completion_note ?? input.completionNote ?? '').trim();
    const at = now();
    db.prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?,
         completion_note = ?, updated_at = ? WHERE id = ?`,
    ).run(at, actor.id, note, at, req.params.id);

    const after = {
      status: 'done',
      completed_at: at,
      completed_by: actor.id,
      completion_note: note,
    };
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.completed',
      entityType: 'task',
      entityId: req.params.id,
      summary: `Completed task "${before.title}"`,
      before,
      after,
    });
    res.json({ row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
  }),
);

tasksRouter.post(
  '/:id/reopen',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as any,
      'Task',
    );
    db.prepare(
      `UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL,
         completion_note = '', updated_at = ? WHERE id = ?`,
    ).run(now(), req.params.id);

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.reopened',
      entityType: 'task',
      entityId: req.params.id,
      summary: `Reopened task "${before.title}"`,
      before,
      after: { status: 'open', completed_at: null, completed_by: null, completion_note: '' },
    });
    res.json({ row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
  }),
);

tasksRouter.post(
  '/:id/cancel',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as any,
      'Task',
    );
    db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
      now(),
      req.params.id,
    );
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.cancelled',
      entityType: 'task',
      entityId: req.params.id,
      summary: `Cancelled task "${before.title}"`,
      before,
      after: { status: 'cancelled' },
    });
    res.json({ row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
  }),
);

tasksRouter.delete(
  '/:id',
  requirePermission('task.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as any,
      'Task',
    );
    if (before.status === 'done') {
      throw conflict('Completed tasks cannot be deleted. Reopen the task first.');
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'task.deleted',
      entityType: 'task',
      entityId: req.params.id,
      summary: `Deleted task "${before.title}"`,
      before,
    });
    res.json({ ok: true });
  }),
);
