import { Router } from 'express';
import { z } from 'zod';
import { getDb, now } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, notFound } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';

export const configRouter = Router();
configRouter.use(requireAuth);

/** Everything the UI needs to render filters, boards and forms. */
configRouter.get(
  '/',
  ah(async (_req, res) => {
    const db = getDb();
    const pick = (sql: string) => db.prepare(sql).all();
    res.json({
      leadSources: pick('SELECT * FROM lead_sources WHERE active = 1 ORDER BY sort, name'),
      territories: pick('SELECT * FROM territories WHERE active = 1 ORDER BY sort, name'),
      timingBuckets: pick('SELECT * FROM timing_buckets WHERE active = 1 ORDER BY sort, name'),
      dispositions: pick('SELECT * FROM dispositions ORDER BY workspace, sort, name'),
      costCategories: pick('SELECT * FROM cost_categories WHERE active = 1 ORDER BY sort, name'),
      scopeTemplates: pick(
        'SELECT id, trade, name, version, active, is_system FROM scope_templates WHERE active = 1 ORDER BY trade',
      ),
      commTemplates: pick(
        'SELECT id, key, name, channel, category, active FROM communication_templates WHERE active = 1 ORDER BY category, name',
      ),
      campaigns: pick('SELECT * FROM drip_campaigns ORDER BY name'),
      benchmarks: pick('SELECT * FROM benchmarks WHERE active = 1 ORDER BY trade, label'),
      wonGates: pick('SELECT * FROM won_gate_configs ORDER BY project_type'),
      trades: db
        .prepare(
          `SELECT DISTINCT trade FROM scope_templates WHERE active = 1
           UNION SELECT 'roofing' UNION SELECT 'framing' UNION SELECT 'demolition'`,
        )
        .all()
        .map((r: any) => r.trade),
      settings: readSettings(),
    });
  }),
);

export function readSettings(): Record<string, any> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, any> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function readSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

configRouter.get(
  '/scope-template/:trade',
  ah(async (req, res) => {
    const row = getDb()
      .prepare(
        'SELECT * FROM scope_templates WHERE trade = ? AND active = 1 ORDER BY version DESC LIMIT 1',
      )
      .get(req.params.trade);
    if (!row) throw notFound('No scope template for that trade.');
    const tpl = row as any;
    res.json({ ...tpl, questions: JSON.parse(tpl.questions) });
  }),
);

configRouter.get(
  '/comm-template/:key',
  ah(async (req, res) => {
    const row = getDb()
      .prepare('SELECT * FROM communication_templates WHERE key = ?')
      .get(req.params.key);
    if (!row) throw notFound('Template not found.');
    res.json(row);
  }),
);

/* ------------------------------ mutations ------------------------------ */

const dispositionSchema = z.object({
  workspace: z.enum(['prospect', 'bid']),
  name: z.string().trim().min(1).max(80),
  key: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores')
    .optional(),
});

configRouter.post(
  '/dispositions',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const input = parseBody(dispositionSchema, req.body);
    const actor = currentUser(req);
    const key = input.key ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const db = getDb();
    const clash = db
      .prepare('SELECT id FROM dispositions WHERE workspace = ? AND key = ?')
      .get(input.workspace, key);
    if (clash) throw notFound('A disposition with that key already exists.');
    const id = newId('dsp');
    db.prepare(
      `INSERT INTO dispositions (id, workspace, key, name, active, is_system, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, 99, ?, ?)`,
    ).run(id, input.workspace, key, input.name, now(), now());
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'disposition.created',
      entityType: 'disposition',
      entityId: id,
      summary: `Created ${input.workspace} disposition "${input.name}"`,
      after: { name: input.name, key },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM dispositions WHERE id = ?').get(id) });
  }),
);

/**
 * Rename or deactivate. The key never changes and rows are never deleted, so
 * historical prospects and bids keep pointing at a valid disposition.
 */
configRouter.patch(
  '/dispositions/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      active: z.boolean().optional(),
      sort: z.number().int().min(0).max(9999).optional(),
    });
    const input = parseBody(schema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM dispositions WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Disposition not found.');

    db.prepare(
      `UPDATE dispositions SET
         name = COALESCE(?, name),
         active = COALESCE(?, active),
         sort = COALESCE(?, sort),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? null,
      input.active === undefined ? null : input.active ? 1 : 0,
      input.sort ?? null,
      now(),
      req.params.id,
    );
    const after = db.prepare('SELECT * FROM dispositions WHERE id = ?').get(req.params.id);
    const usedBy = db
      .prepare(`SELECT COUNT(*) AS n FROM prospects WHERE disposition_id = ?`)
      .get(req.params.id) as any;
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'disposition.updated',
      entityType: 'disposition',
      entityId: req.params.id,
      summary: `Updated disposition "${before.name}"`,
      before: { name: before.name, active: before.active },
      after: { name: (after as any).name, active: (after as any).active },
      meta: { stillReferencedBy: usedBy.n },
    });
    res.json({ row: after, stillReferencedBy: usedBy.n });
  }),
);

const settingsSchema = z.record(z.any());

configRouter.put(
  '/settings/:key',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const value = parseBody(settingsSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const key = req.params.key;
    const before = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    db.prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), actor.id, now());
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'settings.updated',
      entityType: 'settings',
      entityId: key,
      summary: `Updated setting "${key}"`,
      before: before ? JSON.parse(before.value) : null,
      after: value,
    });
    res.json({ key, value });
  }),
);

const benchmarkSchema = z.object({
  trade: z.string().trim().min(1),
  project_type: z.string().trim().default('standard'),
  label: z.string().trim().min(1),
  unit: z.enum(['cost_per_sq', 'price_per_sq', 'price_per_sqft']),
  min_value: z.number().nullable().optional(),
  target_value: z.number().nullable().optional(),
  max_value: z.number().nullable().optional(),
});

configRouter.post(
  '/benchmarks',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const input = parseBody(benchmarkSchema, req.body);
    const actor = currentUser(req);
    const id = newId('bmk');
    getDb()
      .prepare(
        `INSERT INTO benchmarks (id, trade, project_type, label, unit, min_value, target_value, max_value, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.trade,
        input.project_type,
        input.label,
        input.unit,
        input.min_value ?? null,
        input.target_value ?? null,
        input.max_value ?? null,
        now(),
        now(),
      );
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'benchmark.created',
      entityType: 'benchmark',
      entityId: id,
      summary: `Created benchmark "${input.label}"`,
    });
    res.status(201).json({ row: getDb().prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) });
  }),
);

configRouter.delete(
  '/benchmarks/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const row = must(db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(req.params.id), 'Benchmark');
    db.prepare('UPDATE benchmarks SET active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'benchmark.deactivated',
      entityType: 'benchmark',
      entityId: req.params.id,
      summary: `Deactivated benchmark "${(row as any).label}"`,
    });
    res.json({ ok: true });
  }),
);

const gateSchema = z.object({
  project_type: z.string().trim().min(1),
  require_contract_signed: z.number().int().min(0).max(1),
  require_deposit: z.number().int().min(0).max(1),
  require_insurance: z.number().int().min(0).max(1),
  require_compliance: z.number().int().min(0).max(1),
  require_approval: z.number().int().min(0).max(1),
});

configRouter.put(
  '/won-gates/:projectType',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const input = parseBody(gateSchema, req.body);
    if (input.project_type !== req.params.project_type) {
      throw notFound('Project type mismatch.');
    }
    const actor = currentUser(req);
    const db = getDb();
    const before = db
      .prepare('SELECT * FROM won_gate_configs WHERE project_type = ?')
      .get(req.params.project_type);
    db.prepare(
      `UPDATE won_gate_configs SET
         require_contract_signed = ?, require_deposit = ?, require_insurance = ?,
         require_compliance = ?, require_approval = ?, updated_by = ?, updated_at = ?
       WHERE project_type = ?`,
    ).run(
      input.require_contract_signed,
      input.require_deposit,
      input.require_insurance,
      input.require_compliance,
      input.require_approval,
      actor.id,
      now(),
      req.params.project_type,
    );
    const after = db
      .prepare('SELECT * FROM won_gate_configs WHERE project_type = ?')
      .get(req.params.project_type);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'won_gate.updated',
      entityType: 'won_gate',
      entityId: req.params.project_type,
      summary: `Updated the Won gate for ${req.params.project_type} projects`,
      before,
      after,
    });
    res.json({ row: after });
  }),
);
