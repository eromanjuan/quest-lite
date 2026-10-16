import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, parsePagination, page, badRequest } from '../http/helpers.js';
import { notFound, conflict, validationError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { newId, formatNo } from '../core/ids.js';
import { round2 } from '../core/money.js';

const BID_STAGES = ['scope', 'takeoff', 'uw_sheet', 'quote_built'] as const;
type BidStage = (typeof BID_STAGES)[number];

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Union of the missing scope labels across every scope response for the bid.
 * Shared with the estimates module so quote-release gating reads the same
 * source of truth as the scope intake screen.
 */
export function scopeCompletionFor(bidId: string): { complete: boolean; missing: string[] } {
  const rows = getDb()
    .prepare('SELECT missing FROM scope_responses WHERE bid_id = ?')
    .all(bidId) as Array<{ missing: string }>;
  const missing: string[] = [];
  for (const row of rows) {
    for (const label of parseJson<string[]>(row.missing, [])) {
      if (!missing.includes(label)) missing.push(label);
    }
  }
  return { complete: missing.length === 0, missing };
}

/* ================================================================== */
/* Bids — the underwriting workspace                                  */
/* ================================================================== */

export const bidsRouter = Router();
bidsRouter.use(requireAuth);

bidsRouter.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const q = String((req.query as any).q ?? '').trim();
    const stage = String((req.query as any).stage ?? '').trim();
    const dispositionId = String((req.query as any).dispositionId ?? '').trim();
    const estimatorId = String((req.query as any).estimatorId ?? '').trim();
    const temperature = String((req.query as any).temperature ?? '').trim();
    const trade = String((req.query as any).trade ?? '').trim();
    const overdue = (req.query as any).overdue === '1';
    const waiting = (req.query as any).waiting === '1';

    const where: string[] = ['b.archived_at IS NULL'];
    const params: any[] = [];
    if (stage) { where.push('b.stage = ?'); params.push(stage); }
    if (dispositionId) { where.push('b.disposition_id = ?'); params.push(dispositionId); }
    if (estimatorId) { where.push('b.estimator_id = ?'); params.push(estimatorId); }
    if (temperature) { where.push('b.temperature = ?'); params.push(temperature); }
    if (trade) { where.push('b.trade = ?'); params.push(trade); }
    if (q) {
      where.push(
        `(b.bid_no LIKE ? OR b.project_address LIKE ? OR b.scope_summary LIKE ?
          OR (co.first_name || ' ' || co.last_name) LIKE ?)`,
      );
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (overdue) {
      where.push('b.quote_due_at IS NOT NULL AND b.quote_due_at < ?');
      params.push(now());
    }
    if (waiting) {
      where.push(`d.key IN ('waiting_info', 'waiting_sub_quote', 'site_visit_needed')`);
    }

    const joins = `FROM bids b
      JOIN contacts co ON co.id = b.contact_id
      LEFT JOIN companies c ON c.id = b.company_id
      LEFT JOIN dispositions d ON d.id = b.disposition_id
      LEFT JOIN users u ON u.id = b.estimator_id`;
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n ${joins} ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT b.*, (co.first_name || ' ' || co.last_name) AS contact_name,
                c.name AS company_name, d.name AS disposition_name, u.name AS estimator_name
           ${joins} ${clause}
          ORDER BY b.quote_due_at ASC NULLS LAST, b.started_at ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];
    const at = now();
    for (const row of rows) {
      row.bid_age_days = row.started_at ? Math.floor((at - row.started_at) / 86_400_000) : 0;
    }
    res.json(page(rows, total, limit, offset));
  }),
);

const createBidSchema = z.object({
  opportunityId: z.string().trim().min(1).nullish(),
  prospectId: z.string().trim().min(1).nullish(),
  contactId: z.string().trim().min(1),
  companyId: z.string().trim().min(1).nullish(),
  projectAddress: z.string().trim().max(400).default(''),
  trade: z.string().trim().min(1).max(60),
  scopeSummary: z.string().trim().max(4000).default(''),
  estimatorId: z.string().trim().min(1).nullish(),
  quoteDueAt: z.number().int().positive().nullish(),
  takeoffRequired: z.boolean().default(false),
});

bidsRouter.post(
  '/',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(createBidSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM contacts WHERE id = ?').get(input.contactId), 'Contact');
    if (input.opportunityId) {
      must(db.prepare('SELECT id FROM opportunities WHERE id = ?').get(input.opportunityId), 'Opportunity');
    }

    const id = newId('bid');
    tx((txdb) => {
      let temperature = 'warm';
      if (input.prospectId) {
        const prospect = txdb
          .prepare('SELECT id, temperature FROM prospects WHERE id = ?')
          .get(input.prospectId) as any;
        if (!prospect) throw notFound('Prospect not found.');
        const handedOff = txdb.prepare('SELECT id FROM bids WHERE prospect_id = ?').get(input.prospectId) as any;
        if (handedOff) {
          throw conflict('This prospect has already been handed off to Underwriting.', {
            bidId: handedOff.id,
          });
        }
        temperature = prospect.temperature;
      }
      // Sequential bid_no: the count happens inside the transaction so two
      // concurrent requests can never claim the same number.
      const count = (txdb.prepare('SELECT COUNT(*) AS n FROM bids').get() as any).n;
      const bidNo = formatNo('BID', count + 1);
      const at = now();
      txdb
        .prepare(
          `INSERT INTO bids (id, bid_no, opportunity_id, prospect_id, contact_id, company_id, project_address,
             trade, scope_summary, estimator_id, stage, disposition_id, temperature, quote_due_at, started_at,
             takeoff_required, missing_info, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scope', NULL, ?, ?, ?, ?, '[]', ?, ?, ?)`,
        )
        .run(
          id, bidNo,
          input.opportunityId ?? null, input.prospectId ?? null, input.contactId, input.companyId ?? null,
          input.projectAddress, input.trade, input.scopeSummary, input.estimatorId ?? null,
          temperature, input.quoteDueAt ?? null, at, input.takeoffRequired ? 1 : 0,
          actor.id, at, at,
        );
      if (input.opportunityId) {
        txdb
          .prepare(`UPDATE opportunities SET stage = 'underwriting', updated_at = ? WHERE id = ?`)
          .run(at, input.opportunityId);
      }
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.created',
      entityType: 'bid', entityId: id,
      summary: `Opened bid for ${input.trade}`,
      after: { trade: input.trade, contactId: input.contactId, opportunityId: input.opportunityId ?? null },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM bids WHERE id = ?').get(id) });
  }),
);

bidsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const bid = must(
      db
        .prepare(
          `SELECT b.*, (co.first_name || ' ' || co.last_name) AS contact_name,
                  c.name AS company_name, u.name AS estimator_name, d.name AS disposition_name
             FROM bids b
             JOIN contacts co ON co.id = b.contact_id
             LEFT JOIN companies c ON c.id = b.company_id
             LEFT JOIN users u ON u.id = b.estimator_id
             LEFT JOIN dispositions d ON d.id = b.disposition_id
            WHERE b.id = ?`,
        )
        .get(req.params.id),
      'Bid',
    ) as any;

    const scopeResponses = (
      db
        .prepare(
          `SELECT sr.*, st.name AS template_name, st.version AS template_version
             FROM scope_responses sr
             LEFT JOIN scope_templates st ON st.id = sr.template_id
            WHERE sr.bid_id = ?
            ORDER BY sr.created_at ASC`,
        )
        .all(bid.id) as any[]
    ).map((r) => ({ ...r, answers: parseJson(r.answers, {}), missing: parseJson<string[]>(r.missing, []) }));

    const templateRow = db
      .prepare(
        `SELECT * FROM scope_templates WHERE trade = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
      )
      .get(bid.trade) as any;
    const scopeTemplate = templateRow
      ? { ...templateRow, questions: parseJson(templateRow.questions, []) }
      : null;

    const planRevisions = db
      .prepare('SELECT * FROM plan_revisions WHERE bid_id = ? ORDER BY revision_no DESC')
      .all(bid.id);
    const takeoffItems = db
      .prepare('SELECT * FROM takeoff_items WHERE bid_id = ? ORDER BY created_at ASC')
      .all(bid.id);
    const subQuotes = (
      db
        .prepare(
          `SELECT sq.*, v.name AS vendor_name
             FROM sub_quotes sq LEFT JOIN vendors v ON v.id = sq.vendor_id
            WHERE sq.bid_id = ? ORDER BY sq.created_at DESC`,
        )
        .all(bid.id) as any[]
    ).map((r) => ({ ...r, scope_gaps: parseJson(r.scope_gaps, []) }));
    const estimates = (
      db
        .prepare('SELECT * FROM estimates WHERE bid_id = ? ORDER BY version DESC')
        .all(bid.id) as any[]
    ).map((r) => ({ ...r, inputs: parseJson(r.inputs, {}), calc: parseJson(r.calc, {}) }));
    const documents = db
      .prepare(
        `SELECT * FROM documents WHERE owner_type = 'bid' AND owner_id = ? ORDER BY created_at DESC`,
      )
      .all(bid.id);
    const marginApprovals = db
      .prepare('SELECT * FROM margin_approvals WHERE bid_id = ? ORDER BY requested_at DESC')
      .all(bid.id);

    res.json({
      bid,
      scopeResponses,
      scopeTemplate,
      planRevisions,
      takeoffItems,
      subQuotes,
      estimates,
      documents,
      marginApprovals,
      missing: scopeCompletionFor(bid.id).missing,
    });
  }),
);

const updateBidSchema = z.object({
  projectAddress: z.string().trim().max(400).optional(),
  scopeSummary: z.string().trim().max(4000).optional(),
  estimatorId: z.string().trim().min(1).nullish(),
  quoteDueAt: z.number().int().positive().nullable().optional(),
  temperature: z.enum(['hot', 'warm', 'cold']).optional(),
  dispositionId: z.string().trim().min(1).nullish(),
  takeoffRequired: z.boolean().optional(),
  perform_mode: z.enum(['self', 'sub', 'mixed']).optional(),
  stage: z.enum(['scope', 'takeoff', 'uw_sheet', 'quote_built']).optional(),
});

bidsRouter.patch(
  '/:id',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(updateBidSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM bids WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Bid not found.');

    // Stage may move forward one step, or backward any number of steps
    // (a bid reopened after a scope gap); never forward more than one.
    if (input.stage !== undefined && input.stage !== before.stage) {
      const from = BID_STAGES.indexOf(before.stage as BidStage);
      const to = BID_STAGES.indexOf(input.stage);
      if (from === -1 || (to !== from + 1 && to > from)) {
        throw conflict(`A bid cannot move from "${before.stage}" to "${input.stage}".`, {
          from: before.stage, to: input.stage,
        });
      }
    }

    const patch: any = {
      project_address: input.projectAddress ?? before.project_address,
      scope_summary: input.scopeSummary ?? before.scope_summary,
      estimator_id: input.estimatorId === undefined ? before.estimator_id : input.estimatorId,
      quote_due_at: input.quoteDueAt === undefined ? before.quote_due_at : input.quoteDueAt,
      temperature: input.temperature ?? before.temperature,
      disposition_id: input.dispositionId === undefined ? before.disposition_id : input.dispositionId,
      takeoff_required: input.takeoffRequired === undefined ? before.takeoff_required : input.takeoffRequired ? 1 : 0,
      perform_mode: input.perform_mode ?? before.perform_mode,
      stage: input.stage ?? before.stage,
    };
    db.prepare(
      `UPDATE bids SET project_address=@project_address, scope_summary=@scope_summary, estimator_id=@estimator_id,
         quote_due_at=@quote_due_at, temperature=@temperature, disposition_id=@disposition_id,
         takeoff_required=@takeoff_required, perform_mode=@perform_mode, stage=@stage, updated_at=@updated_at
       WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM bids WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.updated',
      entityType: 'bid', entityId: req.params.id,
      summary: patch.stage !== before.stage
        ? `Bid moved from ${before.stage} to ${patch.stage}`
        : `Updated bid ${before.bid_no}`,
      before, after,
    });
    res.json({ row: after });
  }),
);

const scopeAnswersSchema = z.object({ answers: z.record(z.string(), z.any()) });

bidsRouter.post(
  '/:id/scope',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(scopeAnswersSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const bid = must(db.prepare('SELECT id, trade FROM bids WHERE id = ?').get(req.params.id), 'Bid') as any;
    const template = must(
      db
        .prepare(`SELECT * FROM scope_templates WHERE trade = ? AND active = 1 ORDER BY version DESC LIMIT 1`)
        .get(bid.trade),
      'Active scope template for this trade',
    ) as any;
    const questions = parseJson<Array<{ id: string; label: string; required?: boolean }>>(
      template.questions,
      [],
    );

    const known = new Set(questions.map((q) => q.id));
    const unknown = Object.keys(input.answers).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw validationError('Some answers do not belong to this scope template.', {
        unknown,
        templateId: template.id,
      });
    }

    const isEmpty = (v: unknown) =>
      v === undefined ||
      v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0);
    const missing = questions
      .filter((q) => q.required === true && isEmpty((input.answers as Record<string, unknown>)[q.id]))
      .map((q) => q.label);
    const complete = missing.length === 0;
    const at = now();

    tx((txdb) => {
      txdb
        .prepare(
          `INSERT INTO scope_responses (id, bid_id, template_id, answers, missing, complete, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bid_id, template_id) DO UPDATE SET
             answers = excluded.answers, missing = excluded.missing, complete = excluded.complete,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(
          newId('scop'), bid.id, template.id,
          JSON.stringify(input.answers), JSON.stringify(missing), complete ? 1 : 0,
          actor.id, at, at,
        );
      // Bid-level missing_info is the union across every scope response.
      const bidMissing = scopeCompletionFor(bid.id).missing;
      txdb
        .prepare('UPDATE bids SET missing_info = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(bidMissing), at, bid.id);
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.scope_updated',
      entityType: 'bid', entityId: bid.id,
      summary: `Scope intake saved for ${bid.trade}`,
      meta: { missing, complete },
    });

    const row = db
      .prepare('SELECT * FROM scope_responses WHERE bid_id = ? AND template_id = ?')
      .get(bid.id, template.id);
    res.json({ row, missing, complete });
  }),
);

const planRevisionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000).default(''),
  filename: z.string().trim().max(255).nullish(),
  mime: z.string().trim().max(120).nullish(),
  size: z.number().int().nonnegative().nullish(),
});

bidsRouter.post(
  '/:id/plans',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(planRevisionSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const bid = must(db.prepare('SELECT id FROM bids WHERE id = ?').get(req.params.id), 'Bid') as any;
    const id = newId('pln');
    let documentId: string | null = null;

    tx((txdb) => {
      const maxNo = (
        txdb.prepare('SELECT COALESCE(MAX(revision_no), 0) AS n FROM plan_revisions WHERE bid_id = ?').get(bid.id) as any
      ).n;
      txdb.prepare('UPDATE plan_revisions SET is_current = 0 WHERE bid_id = ?').run(bid.id);

      // Uploads are only RECORDED here (the intended path is stored on the
      // document row); bytes are written and served in a later step.
      if (input.filename) {
        const filename = input.filename.split(/[\\/]/).pop()?.trim() ?? '';
        if (!filename) throw badRequest('A filename is required to attach a plan document.');
        documentId = newId('doc');
        const at = now();
        txdb
          .prepare(
            `INSERT INTO documents (id, owner_type, owner_id, kind, filename, mime, size, path, version, uploaded_by, created_at)
             VALUES (?, 'bid', ?, 'blueprint', ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(documentId, bid.id, filename, input.mime ?? '', input.size ?? 0, `/uploads/plans/${id}/${filename}`, actor.id, at);
      }

      const at = now();
      txdb
        .prepare(
          `INSERT INTO plan_revisions (id, bid_id, revision_no, label, document_id, is_current, notes, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(id, bid.id, maxNo + 1, input.label, documentId, input.notes, actor.id, at);
      txdb
        .prepare('UPDATE bids SET current_plan_revision_id = ?, updated_at = ? WHERE id = ?')
        .run(id, at, bid.id);
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.plan_revision_added',
      entityType: 'bid', entityId: bid.id,
      summary: `Added plan revision "${input.label}"`,
      meta: { revisionId: id, documentId },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM plan_revisions WHERE id = ?').get(id) });
  }),
);

const takeoffSchema = z.object({
  planRevisionId: z.string().trim().min(1),
  code: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  qty: z.number().nonnegative(),
  unit: z.string().trim().max(20).default('EA'),
  estimateLineRef: z.string().trim().max(60).nullish(),
});

bidsRouter.post(
  '/:id/takeoff',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(takeoffSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM bids WHERE id = ?').get(req.params.id), 'Bid');
    const revision = must(
      db
        .prepare('SELECT id, is_current FROM plan_revisions WHERE id = ? AND bid_id = ?')
        .get(input.planRevisionId, req.params.id),
      'Plan revision',
    ) as any;
    if (!revision.is_current) {
      throw conflict(
        'Quantities must be tied to the current plan revision. Add them to the current revision instead.',
        { planRevisionId: input.planRevisionId },
      );
    }

    const id = newId('tco');
    const at = now();
    db.prepare(
      `INSERT INTO takeoff_items (id, bid_id, plan_revision_id, code, description, qty, unit, estimate_line_ref,
         review_status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', '', ?, ?, ?)`,
    ).run(
      id, req.params.id, input.planRevisionId, input.code, input.description,
      round2(input.qty), input.unit, input.estimateLineRef ?? null, actor.id, at, at,
    );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.takeoff_item_added',
      entityType: 'bid', entityId: req.params.id,
      summary: `Added takeoff item ${input.code}`,
      meta: { itemId: id, code: input.code, qty: input.qty, unit: input.unit },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM takeoff_items WHERE id = ?').get(id) });
  }),
);

const takeoffPatchSchema = z.object({
  qty: z.number().nonnegative().optional(),
  unit: z.string().trim().max(20).optional(),
  description: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(5000).optional(),
  review_status: z.enum(['draft', 'reviewed', 'disputed']).optional(),
});

bidsRouter.patch(
  '/takeoff/:id',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(takeoffPatchSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM takeoff_items WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Takeoff item not found.');

    const patch: any = {
      qty: input.qty === undefined ? before.qty : round2(input.qty),
      unit: input.unit ?? before.unit,
      description: input.description ?? before.description,
      notes: input.notes ?? before.notes,
      review_status: input.review_status ?? before.review_status,
      reviewer_id: before.reviewer_id,
    };
    // Marking reviewed records who reviewed it; later status flips keep them.
    if (input.review_status === 'reviewed' && before.review_status !== 'reviewed') {
      patch.reviewer_id = actor.id;
    }
    db.prepare(
      `UPDATE takeoff_items SET qty=@qty, unit=@unit, description=@description, notes=@notes,
         review_status=@review_status, reviewer_id=@reviewer_id, updated_at=@updated_at WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM takeoff_items WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.takeoff_item_updated',
      entityType: 'bid', entityId: before.bid_id,
      summary: `Updated takeoff item ${before.code}`,
      before, after,
    });
    res.json({ row: after });
  }),
);

bidsRouter.delete(
  '/takeoff/:id',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM takeoff_items WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Takeoff item not found.');
    db.prepare('DELETE FROM takeoff_items WHERE id = ?').run(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.takeoff_item_removed',
      entityType: 'bid', entityId: before.bid_id,
      summary: `Removed takeoff item ${before.code}`,
      before,
    });
    res.json({ ok: true });
  }),
);

const scopeGapSchema = z.object({
  gap: z.string().trim().max(500),
  responsible: z.string().trim().max(120).default(''),
  cost: z.number().nonnegative().default(0),
});

const subQuoteSchema = z.object({
  vendorId: z.string().trim().min(1).nullish(),
  amount: z.number().nonnegative(),
  quoteDate: z.number().int().positive().nullish(),
  validUntil: z.number().int().positive().nullish(),
  includes: z.string().trim().max(4000).default(''),
  excludes: z.string().trim().max(4000).default(''),
  scopeGaps: z.array(scopeGapSchema).default([]),
  documentId: z.string().trim().min(1).nullish(),
  status: z.enum(['requested', 'received', 'accepted', 'declined', 'expired']).default('requested'),
});

bidsRouter.post(
  '/:id/sub-quotes',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(subQuoteSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    must(db.prepare('SELECT id FROM bids WHERE id = ?').get(req.params.id), 'Bid');
    if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');
    if (input.documentId) must(db.prepare('SELECT id FROM documents WHERE id = ?').get(input.documentId), 'Document');

    const id = newId('sqt');
    const at = now();
    db.prepare(
      `INSERT INTO sub_quotes (id, bid_id, vendor_id, amount, quote_date, valid_until, includes, excludes,
         scope_gaps, status, document_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, req.params.id, input.vendorId ?? null, round2(input.amount),
      input.quoteDate ?? null, input.validUntil ?? null, input.includes, input.excludes,
      JSON.stringify(input.scopeGaps), input.status, input.documentId ?? null, actor.id, at, at,
    );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.sub_quote_added',
      entityType: 'bid', entityId: req.params.id,
      summary: `Recorded sub quote of ${round2(input.amount)}`,
      meta: { subQuoteId: id, vendorId: input.vendorId ?? null, amount: round2(input.amount) },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM sub_quotes WHERE id = ?').get(id) });
  }),
);

bidsRouter.patch(
  '/sub-quotes/:id',
  requirePermission('bid.write'),
  ah(async (req, res) => {
    const input = parseBody(subQuoteSchema.partial(), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM sub_quotes WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Sub quote not found.');
    if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');
    if (input.documentId) must(db.prepare('SELECT id FROM documents WHERE id = ?').get(input.documentId), 'Document');

    const patch: any = {
      vendor_id: input.vendorId === undefined ? before.vendor_id : input.vendorId,
      amount: input.amount === undefined ? before.amount : round2(input.amount),
      quote_date: input.quoteDate === undefined ? before.quote_date : input.quoteDate,
      valid_until: input.validUntil === undefined ? before.valid_until : input.validUntil,
      includes: input.includes ?? before.includes,
      excludes: input.excludes ?? before.excludes,
      scope_gaps: input.scopeGaps === undefined ? before.scope_gaps : JSON.stringify(input.scopeGaps),
      status: input.status ?? before.status,
      document_id: input.documentId === undefined ? before.document_id : input.documentId,
    };
    db.prepare(
      `UPDATE sub_quotes SET vendor_id=@vendor_id, amount=@amount, quote_date=@quote_date, valid_until=@valid_until,
         includes=@includes, excludes=@excludes, scope_gaps=@scope_gaps, status=@status, document_id=@document_id,
         updated_at=@updated_at WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM sub_quotes WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.sub_quote_updated',
      entityType: 'bid', entityId: before.bid_id,
      summary: `Updated sub quote for ${before.bid_id}`,
      before, after,
    });
    res.json({ row: after });
  }),
);
