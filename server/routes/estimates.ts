import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser, userCan } from '../auth/middleware.js';
import { ah, parseBody, must, notFound, badRequest, conflict, forbidden } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';
import { round2, num } from '../core/money.js';
import {
  computeEstimate,
  checkMarginFloor,
  flagBenchmarks,
  priceForGrossMargin,
  priceForNetMargin,
  type EstimateInputs,
} from '../domain/estimating/calc.js';
import { evaluateQuoteRelease } from '../domain/workflow/gates.js';
import { readSetting } from './config.js';

export const estimatesRouter = Router();
estimatesRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const lineSchema = z.object({
  id: z.string().optional(),
  code: z.string().max(40).optional(),
  description: z.string().max(400).default(''),
  qty: z.number().finite(),
  unit: z.string().max(20).default('ea'),
  unitPrice: z.number().finite(),
  categoryId: z.string().nullish(),
  categoryKey: z.string().nullish(),
  taxable: z.boolean().default(false),
});

const inputsSchema = z.object({
  sheet: z.enum(['roofing', 'crew', 'generic']).default('generic'),
  taxRate: z.number().finite().min(0).max(100).default(8.5),
  commissionPct: z.number().finite().min(0).max(100).default(10),
  otherExpenses: z.number().finite().min(0).default(0),
  sellLines: z.array(lineSchema).max(500).default([]),
  costLines: z.array(lineSchema).max(500).default([]),
  areaSqft: z.number().finite().min(0).optional(),
  /** Narrative scope of work / exclusions released with the quote. */
  scopeText: z.string().max(20000).default(''),
  exclusionsText: z.string().max(20000).default(''),
  options: z
    .array(
      z.object({
        key: z.string().max(40),
        label: z.string().max(120),
        price: z.number().finite().min(0),
        scope: z.string().max(8000).default(''),
      }),
    )
    .max(10)
    .default([]),
});

function normalizeInputs(raw: any): EstimateInputs {
  const parsed = inputsSchema.parse(raw ?? {});
  return {
    ...parsed,
    sellLines: parsed.sellLines.map((l) => ({ ...l, kind: 'sell' } as any)),
    costLines: parsed.costLines.map((l) => ({ ...l, kind: 'cost' } as any)),
  };
}

function marginFloorFor(trade?: string): number {
  const cfg = readSetting<{ default: number; by_trade: Record<string, number> }>('margin_floor', {
    default: 15,
    by_trade: {},
  });
  if (trade && typeof cfg.by_trade?.[trade] === 'number') return cfg.by_trade[trade];
  return num(cfg.default);
}

function calcResponse(inputs: EstimateInputs, trade?: string) {
  const calc = computeEstimate(inputs);
  const floor = marginFloorFor(trade);
  const margin = checkMarginFloor(calc, floor);
  const benchmarks = getDb()
    .prepare('SELECT * FROM benchmarks WHERE active = 1 AND (trade = ? OR trade = "all")')
    .all(trade ?? '');
  const flags = flagBenchmarks(benchmarks as any, calc);
  return { calc, floor, margin, benchmarkFlags: flags, trade: trade ?? '' };
}

/* ------------------------------------------------------------------ */
/* Live calculation (no persistence) — the estimator's calculator      */
/* ------------------------------------------------------------------ */

const previewSchema = z.object({
  bidId: z.string().optional(),
  inputs: z.unknown(),
});

estimatesRouter.post(
  '/preview',
  requirePermission('estimate.write'),
  ah(async (req, res) => {
    const body = parseBody(previewSchema, req.body);
    const inputs = normalizeInputs(body.inputs);
    let trade = '';
    if (body.bidId) {
      const bid = getDb().prepare('SELECT trade FROM bids WHERE id = ?').get(body.bidId) as any;
      if (!bid) throw notFound('Bid not found.');
      trade = bid.trade;
    }
    res.json(calcResponse(inputs, trade));
  }),
);

/** Target-margin calculator: what must we charge to hit this margin? */
estimatesRouter.post(
  '/target-price',
  requirePermission('estimate.write'),
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        metric: z.enum(['gross', 'net']).default('gross'),
        targetMarginPct: z.number().min(-100).max(99.9),
        hardCost: z.number().finite().min(0),
        commissionPct: z.number().finite().min(0).max(100).default(0),
        otherExpenses: z.number().finite().min(0).default(0),
      }),
      req.body,
    );
    const target = body.targetMarginPct / 100;
    const price =
      body.metric === 'net'
        ? priceForNetMargin(target, body.hardCost, body.commissionPct, body.otherExpenses)
        : priceForGrossMargin(target, body.hardCost);

    if (price === null) {
      return res.status(422).json({
        error: {
          code: 'validation',
          message:
            'That target margin cannot be reached with these costs — commission plus the target exceeds 100%.',
        },
      });
    }
    // Show what the price actually delivers so the estimator sees the round-trip.
    const commission = round2((price * body.commissionPct) / 100);
    const grossProfit = round2(price - body.hardCost);
    const netProfit = round2(price - body.hardCost - commission - body.otherExpenses);
    res.json({
      price,
      grossProfit,
      grossMarginPct: price > 0 ? round2((grossProfit / price) * 100) : null,
      netProfit,
      netMarginPct: price > 0 ? round2((netProfit / price) * 100) : null,
      commission,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Estimate versions                                                   */
/* ------------------------------------------------------------------ */

function loadEstimate(id: string) {
  const row = getDb().prepare('SELECT * FROM estimates WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    ...row,
    inputs: JSON.parse(row.inputs || '{}'),
    calc: JSON.parse(row.calc || '{}'),
  };
}

estimatesRouter.get(
  '/bid/:bidId',
  ah(async (req, res) => {
    const bid = getDb().prepare('SELECT * FROM bids WHERE id = ?').get(req.params.bidId);
    if (!bid) throw notFound('Bid not found.');
    const rows = (getDb()
      .prepare('SELECT * FROM estimates WHERE bid_id = ? ORDER BY version DESC')
      .all(req.params.bidId) as any[])
      .map((r) => ({ ...r, inputs: JSON.parse(r.inputs || '{}'), calc: JSON.parse(r.calc || '{}') }));
    res.json({ bid, estimates: rows });
  }),
);

estimatesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const est = loadEstimate(req.params.id);
    if (!est) throw notFound('Estimate not found.');
    const bid = getDb().prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;
    const lines = getDb()
      .prepare(
        `SELECT l.*, c.key AS category_key, c.name AS category_name
           FROM estimate_lines l LEFT JOIN cost_categories c ON c.id = l.category_id
          WHERE l.estimate_id = ? ORDER BY l.kind DESC, l.seq ASC`,
      )
      .all(req.params.id);
    const approvals = getDb()
      .prepare(
        `SELECT m.*, u.name AS requested_by_name, d.name AS decided_by_name
           FROM margin_approvals m
           LEFT JOIN users u ON u.id = m.requested_by
           LEFT JOIN users d ON d.id = m.decided_by
          WHERE m.estimate_id = ? ORDER BY m.requested_at DESC`,
      )
      .all(req.params.id);
    res.json({
      estimate: est,
      bid,
      lines,
      approvals,
      ...calcResponse(normalizeInputs(est.inputs), bid?.trade),
    });
  }),
);

const createSchema = inputsSchema.extend({
  title: z.string().max(200).default(''),
  parentEstimateId: z.string().nullish(),
});

estimatesRouter.post(
  '/bid/:bidId',
  requirePermission('estimate.write'),
  ah(async (req, res) => {
    const input = parseBody(createSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(req.params.bidId) as any;
    if (!bid) throw notFound('Bid not found.');
    if (bid.archived_at) throw conflict('This bid is archived.');

    const inputs = normalizeInputs(input);
    const result = tx((t) => {
      const nextVersion =
        ((t.prepare('SELECT MAX(version) AS v FROM estimates WHERE bid_id = ?').get(bid.id) as any)?.v ?? 0) + 1;
      const id = newId('est');
      const calc = computeEstimate(inputs);
      t.prepare(
        `INSERT INTO estimates (id, bid_id, version, status, sheet_kind, title, inputs, calc,
           margin_floor, parent_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, bid.id, nextVersion, inputs.sheet, input.title, JSON.stringify(inputs),
        JSON.stringify(calc), marginFloorFor(bid.trade), input.parentEstimateId ?? null,
        actor.id, now(), now(),
      );
      persistLines(t, id, inputs);
      if (bid.stage === 'scope') {
        t.prepare(`UPDATE bids SET stage = 'uw_sheet', updated_at = ? WHERE id = ?`).run(now(), bid.id);
      }
      return { id, version: nextVersion };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'estimate.created',
      entityType: 'estimate', entityId: result.id,
      summary: `Created estimate v${result.version} for ${bid.bid_no}`,
      after: { version: result.version, sheet: inputs.sheet },
    });
    res.status(201).json({ estimate: loadEstimate(result.id) });
  }),
);

function persistLines(t: any, estimateId: string, inputs: EstimateInputs) {
  const nowTs = now();
  t.prepare('DELETE FROM estimate_lines WHERE estimate_id = ?').run(estimateId);
  const insert = t.prepare(
    `INSERT INTO estimate_lines (id, estimate_id, category_id, kind, code, description, qty, unit,
       unit_price, amount, taxable, seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const catByKey = new Map<string, string>();
  for (const c of t.prepare('SELECT id, key FROM cost_categories').all() as any[]) {
    catByKey.set(c.key, c.id);
  }
  let seq = 0;
  const write = (line: any, kind: 'sell' | 'cost') => {
    const amount = round2(num(line.qty) * num(line.unitPrice));
    const categoryId =
      line.categoryId ?? (line.categoryKey ? (catByKey.get(line.categoryKey) ?? catByKey.get('other')) : null);
    insert.run(
      newId('ln'), estimateId, categoryId, kind, line.code ?? '', line.description ?? '',
      num(line.qty), line.unit ?? 'ea', num(line.unitPrice), amount,
      line.taxable ? 1 : 0, seq++, nowTs, nowTs,
    );
  };
  for (const l of inputs.sellLines) write(l, 'sell');
  for (const l of inputs.costLines) write(l, 'cost');
}

/**
 * Updating an estimate recomputes it on the server — the client's numbers are
 * never trusted. Released quotes are immutable: a change requires a new version.
 */
estimatesRouter.patch(
  '/:id',
  requirePermission('estimate.write'),
  ah(async (req, res) => {
    const est = loadEstimate(req.params.id);
    if (!est) throw notFound('Estimate not found.');
    if (est.status === 'released') {
      throw conflict(
        'This quote has been released. Create a new version instead of editing a released quote.',
      );
    }
    const input = parseBody(
      z.object({ inputs: inputsSchema.optional(), title: z.string().max(200).optional() }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;

    const inputs = input.inputs !== undefined ? normalizeInputs(input.inputs) : normalizeInputs(est.inputs);
    const calc = computeEstimate(inputs);

    const before = { inputs: est.inputs, calc: est.calc, status: est.status };

    tx((t) => {
      t.prepare(
        `UPDATE estimates SET inputs = ?, calc = ?, sheet_kind = ?, title = COALESCE(?, title),
           margin_floor = ?, updated_at = ? WHERE id = ?`,
      ).run(
        JSON.stringify(inputs), JSON.stringify(calc), inputs.sheet,
        input.title ?? null, marginFloorFor(bid?.trade), now(), est.id,
      );
      persistLines(t, est.id, inputs);

      // Revalidate approvals: a pricing change voids any standing exception.
      const standing = t
        .prepare(`SELECT COUNT(*) AS n FROM margin_approvals WHERE estimate_id = ? AND status = 'approved'`)
        .get(est.id) as any;
      if (standing.n > 0) {
        t.prepare(
          `UPDATE margin_approvals SET status = 'expired', decision_note =
             decision_note || ' [Auto-expired: pricing changed after approval.]'
           WHERE estimate_id = ? AND status = 'approved'`,
        ).run(est.id);
        audit({
          actorId: actor.id, actorName: actor.name, action: 'margin_approval.invalidated',
          entityType: 'estimate', entityId: est.id,
          summary: 'Pricing changed — prior margin exception invalidated',
          meta: { count: standing.n },
        });
      }
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'estimate.updated',
      entityType: 'estimate', entityId: est.id,
      summary: `Recomputed estimate v${est.version}`,
      before, after: { inputs, calc },
    });
    res.json({ estimate: loadEstimate(est.id), ...calcResponse(inputs, bid?.trade) });
  }),
);

/* ------------------------------------------------------------------ */
/* Margin-floor exceptions                                             */
/* ------------------------------------------------------------------ */

estimatesRouter.post(
  '/:id/request-exception',
  requirePermission('margin.request_exception'),
  ah(async (req, res) => {
    const est = loadEstimate(req.params.id);
    if (!est) throw notFound('Estimate not found.');
    const input = parseBody(
      z.object({ reason: z.string().trim().min(10).max(2000) }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;
    const calc = computeEstimate(normalizeInputs(est.inputs));
    const floor = marginFloorFor(bid?.trade);
    const check = checkMarginFloor(calc, floor);

    if (!check.below) {
      throw badRequest('This estimate is already at or above the margin floor — no exception is needed.');
    }

    const pending = db
      .prepare(`SELECT id FROM margin_approvals WHERE estimate_id = ? AND status = 'pending'`)
      .get(est.id);
    if (pending) throw conflict('An exception request for this estimate is already pending.');

    const actualPct = (check.metric === 'net' ? calc.netMargin : calc.grossMargin) ?? 0;
    const id = newId('mar');
    db.prepare(
      `INSERT INTO margin_approvals (id, estimate_id, bid_id, requested_margin, floor_margin, reason,
         status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, est.id, est.bid_id, round2(actualPct * 100), round2(floor), input.reason, actor.id, now());

    audit({
      actorId: actor.id, actorName: actor.name, action: 'margin_exception.requested',
      entityType: 'estimate', entityId: est.id,
      summary: `Requested a margin exception (${round2(actualPct * 100)}% vs ${round2(floor)}% floor)`,
      meta: { approvalId: id, requestedMargin: round2(actualPct * 100), floor },
    });
    res.status(201).json({ approval: db.prepare('SELECT * FROM margin_approvals WHERE id = ?').get(id) });
  }),
);

estimatesRouter.post(
  '/margin-approvals/:id/decide',
  requirePermission('margin.approve_exception'),
  ah(async (req, res) => {
    const input = parseBody(
      z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(2000).default('') }),
      req.body,
    );
    const actor = currentUser(req);
    const db = getDb();
    const row = db.prepare('SELECT * FROM margin_approvals WHERE id = ?').get(req.params.id) as any;
    if (!row) throw notFound('Approval not found.');
    if (row.status !== 'pending') throw conflict(`This request was already ${row.status}.`);

    db.prepare(
      `UPDATE margin_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
    ).run(input.decision, actor.id, now(), input.note, req.params.id);

    audit({
      actorId: actor.id, actorName: actor.name,
      action: input.decision === 'approved' ? 'margin_exception.approved' : 'margin_exception.rejected',
      entityType: 'estimate', entityId: row.estimate_id,
      summary: `${input.decision === 'approved' ? 'Approved' : 'Rejected'} a margin exception at ${row.requested_margin}% (floor ${row.floor_margin}%)`,
      before: { status: 'pending' }, after: { status: input.decision, note: input.note },
    });
    res.json({ approval: db.prepare('SELECT * FROM margin_approvals WHERE id = ?').get(req.params.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* Release → Sales                                                     */
/* ------------------------------------------------------------------ */

estimatesRouter.get(
  '/:id/release-check',
  ah(async (req, res) => {
    res.json(await releaseCheck(req.params.id, req));
  }),
);

async function releaseCheck(estimateId: string, req: any) {
  const db = getDb();
  const est = loadEstimate(estimateId);
  if (!est) throw notFound('Estimate not found.');
  const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;

  const scope = db
    .prepare('SELECT answers, missing FROM scope_responses WHERE bid_id = ?')
    .all(bid.id) as any[];
  const missingScope = scope.flatMap((s) => JSON.parse(s.missing || '[]'));
  const scopeComplete = missingScope.length === 0 && scope.length > 0;

  const exclusionsText = (est.inputs as any)?.exclusionsText ?? '';

  const takeoffCount = (db
    .prepare('SELECT COUNT(*) AS n FROM takeoff_items WHERE bid_id = ?')
    .get(bid.id) as any).n;
  const reviewed = (db
    .prepare(`SELECT COUNT(*) AS n FROM takeoff_items WHERE bid_id = ? AND review_status = 'reviewed'`)
    .get(bid.id) as any).n;

  const calc = computeEstimate(normalizeInputs(est.inputs));
  const floor = marginFloorFor(bid.trade);
  const approved = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM margin_approvals WHERE estimate_id = ? AND status = 'approved'`,
    )
    .get(est.id) as any).n;
  const pending = (db
    .prepare(`SELECT COUNT(*) AS n FROM margin_approvals WHERE estimate_id = ? AND status = 'pending'`)
    .get(est.id) as any).n;

  const gate = evaluateQuoteRelease({
    sheetKind: inputs_sheet(est),
    hasSellLines: calc.sellSubtotal > 0,
    hasCostLines: calc.costSubtotal > 0,
    pricingValid: !calc.flags.some((f) => f.level === 'bad'),
    scopeComplete,
    missingScope,
    scopeOfWorkText: (est.inputs as any)?.scopeText ?? '',
    exclusionsText,
    takeoffRequired: bid.takeoff_required === 1,
    takeoffItemCount: takeoffCount,
    takeoffReviewed: reviewed > 0 || bid.takeoff_required === 0,
    marginFloor: floor,
    grossMarginPct: calc.grossMargin === null ? null : round2(calc.grossMargin * 100),
    netMarginPct: calc.netMargin === null ? null : round2(calc.netMargin * 100),
    approvedException: approved > 0,
    pendingApprovals: pending,
  });

  return {
    ok: gate.ok,
    blockers: gate.blockers,
    calc,
    marginFloor: floor,
    bidId: bid.id,
    bidNo: bid.bid_no,
    requiresApprovalRole: !userCan(req, 'estimate.release'),
  };
}

function inputs_sheet(est: any): string {
  try { return String(est.inputs?.sheet ?? 'generic'); } catch { return 'generic'; }
}

estimatesRouter.post(
  '/:id/release',
  requirePermission('estimate.release'),
  ah(async (req, res) => {
    const est = loadEstimate(req.params.id);
    if (!est) throw notFound('Estimate not found.');
    if (est.status === 'released') throw conflict('This quote has already been released.');
    const actor = currentUser(req);
    const db = getDb();

    const check = await releaseCheck(est.id, req);
    if (!check.ok) {
      return res.status(422).json({
        error: {
          code: 'validation',
          message: 'This quote cannot be released yet.',
          details: { blockers: check.blockers },
        },
        blockers: check.blockers,
      });
    }

    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(est.bid_id) as any;

    const result = tx((t) => {
      t.prepare(
        `UPDATE estimates SET status = 'superseded', updated_at = ?
          WHERE bid_id = ? AND status = 'released' AND id != ?`,
      ).run(now(), bid.id, est.id);
      t.prepare(
        `UPDATE estimates SET status = 'released', released_at = ?, released_by = ?, updated_at = ? WHERE id = ?`,
      ).run(now(), actor.id, now(), est.id);

      t.prepare(
        `UPDATE bids SET stage = 'quote_built', released_at = ?, released_estimate_id = ?, updated_at = ? WHERE id = ?`,
      ).run(now(), est.id, now(), bid.id);

      return { estimateId: est.id };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'estimate.released',
      entityType: 'estimate', entityId: est.id,
      summary: `Released ${bid.bid_no} quote v${est.version} to Sales`,
      after: { status: 'released', sellingPrice: check.calc.sellingPrice, grossMarginPct: check.calc.grossMargin },
      meta: { marginFloor: check.marginFloor },
    });

    res.json({ ok: true, ...result, calc: check.calc });
  }),
);
