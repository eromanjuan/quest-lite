import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, notFound, badRequest, conflict, parsePagination, page } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';
import { evaluateHandoffQualification } from '../domain/workflow/gates.js';

export const prospectingRouter = Router();
prospectingRouter.use(requireAuth);

const STAGES = ['prospect', 'lead', 'nurturing'] as const;
const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
const TIMING = ['within_2w', 'within_month', 'follow_month', 'custom'] as const;

const stageIndex = (s: string) => STAGES.indexOf(s as any);

/* ------------------------------------------------------------------ */
/* List + filters                                                      */
/* ------------------------------------------------------------------ */

prospectingRouter.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 50);
    const q = String((req.query as any).q ?? '').trim();
    const stage = String((req.query as any).stage ?? '');
    const temperature = String((req.query as any).temperature ?? '');
    const timing = String((req.query as any).timing ?? '');
    const dispositionId = String((req.query as any).dispositionId ?? '');
    const ownerId = String((req.query as any).ownerId ?? '');
    const sourceId = String((req.query as any).sourceId ?? '');
    const territoryId = String((req.query as any).territoryId ?? '');
    const overdue = (req.query as any).overdue === '1';
    const sort = String((req.query as any).sort ?? 'next_followup');

    const where: string[] = ['p.archived_at IS NULL'];
    const params: any[] = [];
    const add = (sql: string, ...v: any[]) => { where.push(sql); params.push(...v); };

    if (q) {
      add(
        `(co.first_name LIKE ? OR co.last_name LIKE ? OR co.phone LIKE ? OR co.mobile LIKE ?
          OR co.email LIKE ? OR p.project_address LIKE ? OR p.scope_summary LIKE ? OR c.name LIKE ?)`,
        ...Array(8).fill(`%${q}%`),
      );
    }
    if (stage) add('p.stage = ?', stage);
    if (temperature) add('p.temperature = ?', temperature);
    if (timing) add('p.timing = ?', timing);
    if (dispositionId) add('p.disposition_id = ?', dispositionId);
    if (ownerId) add('p.owner_id = ?', ownerId);
    if (sourceId) add('p.source_id = ?', sourceId);
    if (territoryId) add('p.territory_id = ?', territoryId);
    if (overdue) add(`p.next_followup_at IS NOT NULL AND p.next_followup_at < ?`, now());

    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM prospects p
                    JOIN contacts co ON co.id = p.contact_id
                    LEFT JOIN companies c ON c.id = p.company_id ${clause}`)
        .get(...params) as any
    ).n;

    const order =
      sort === 'created' ? 'p.created_at DESC'
      : sort === 'temperature' ? `CASE p.temperature WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, p.next_followup_at ASC`
      : sort === 'last_contact' ? 'p.last_contact_at DESC NULLS LAST'
      : 'p.next_followup_at ASC NULLS LAST';

    const rows = getDb()
      .prepare(
        `SELECT p.*,
                co.first_name AS contact_first, co.last_name AS contact_last,
                co.phone, co.mobile, co.email, co.is_decision_maker,
                c.name AS company_name,
                d.name AS disposition_name, d.key AS disposition_key,
                u.name AS owner_name, s.name AS source_name, t.name AS territory_name,
                (SELECT COUNT(*) FROM tasks tk WHERE tk.prospect_id = p.id AND tk.status = 'open') AS open_tasks,
                (SELECT COUNT(*) FROM communications cm WHERE cm.prospect_id = p.id) AS comm_count,
                (SELECT MAX(cm.occurred_at) FROM communications cm WHERE cm.prospect_id = p.id) AS last_comm_at,
                (SELECT b.id FROM bids b WHERE b.prospect_id = p.id LIMIT 1) AS bid_id,
                (SELECT b.bid_no FROM bids b WHERE b.prospect_id = p.id LIMIT 1) AS bid_no,
                (SELECT o.id FROM opportunities o WHERE o.prospect_id = p.id LIMIT 1) AS opportunity_id
           FROM prospects p
           JOIN contacts co ON co.id = p.contact_id
           LEFT JOIN companies c ON c.id = p.company_id
           LEFT JOIN dispositions d ON d.id = p.disposition_id
           LEFT JOIN users u ON u.id = p.owner_id
           LEFT JOIN lead_sources s ON s.id = p.source_id
           LEFT JOIN territories t ON t.id = p.territory_id
           ${clause}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json(page(rows, total, limit, offset));
  }),
);

/** Kanban payload: every card field, grouped by stage. */
prospectingRouter.get(
  '/pipeline',
  ah(async (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT p.id, p.stage, p.temperature, p.timing, p.timing_date, p.next_followup_at,
                p.last_contact_at, p.scope_summary, p.project_address, p.created_at,
                co.id AS contact_id, co.first_name AS contact_first, co.last_name AS contact_last,
                co.phone, co.mobile, co.is_decision_maker,
                c.id AS company_id, c.name AS company_name,
                d.name AS disposition_name, d.key AS disposition_key,
                u.name AS owner_name, s.name AS source_name, t.name AS territory_name,
                (SELECT COUNT(*) FROM tasks tk WHERE tk.prospect_id = p.id AND tk.status = 'open') AS open_tasks,
                (SELECT COUNT(*) FROM tasks tk WHERE tk.prospect_id = p.id AND tk.status = 'open' AND tk.due_at < ?) AS overdue_tasks,
                (SELECT MAX(cm.occurred_at) FROM communications cm WHERE cm.prospect_id = p.id) AS last_comm_at,
                (SELECT b.id FROM bids b WHERE b.prospect_id = p.id LIMIT 1) AS bid_id,
                (SELECT b.bid_no FROM bids b WHERE b.prospect_id = p.id LIMIT 1) AS bid_no
           FROM prospects p
           JOIN contacts co ON co.id = p.contact_id
           LEFT JOIN companies c ON c.id = p.company_id
           LEFT JOIN dispositions d ON d.id = p.disposition_id
           LEFT JOIN users u ON u.id = p.owner_id
           LEFT JOIN lead_sources s ON s.id = p.source_id
           LEFT JOIN territories t ON t.id = p.territory_id
          WHERE p.archived_at IS NULL
          ORDER BY p.next_followup_at ASC NULLS LAST, p.created_at DESC`,
      )
      .all(now());

    const grouped: Record<string, any[]> = { prospect: [], lead: [], nurturing: [] };
    for (const r of rows as any[]) (grouped[r.stage] ??= []).push(r);
    res.json({ stages: STAGES, columns: grouped, total: rows.length });
  }),
);

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

const createSchema = z.object({
  contactId: z.string().min(1).optional(),
  companyId: z.string().nullish(),
  // Or create the contact inline so a rep never has to leave the board.
  newContact: z
    .object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().max(80).default(''),
      phone: z.string().trim().max(40).nullish(),
      mobile: z.string().trim().max(40).nullish(),
      email: z.string().trim().max(200).nullish(),
      title: z.string().trim().max(120).default(''),
      isDecisionMaker: z.boolean().default(false),
      consentSms: z.boolean().default(false),
      consentEmail: z.boolean().default(true),
    })
    .optional(),
  stage: z.enum(STAGES).default('prospect'),
  dispositionId: z.string().nullish(),
  temperature: z.enum(TEMPERATURES).default('warm'),
  timing: z.enum(TIMING).default('within_month'),
  timingDate: z.number().nullish(),
  sourceId: z.string().nullish(),
  territoryId: z.string().nullish(),
  ownerId: z.string().nullish(),
  scopeSummary: z.string().trim().max(4000).default(''),
  projectAddress: z.string().trim().max(400).default(''),
  opportunityName: z.string().trim().max(200).optional(),
  trade: z.string().trim().max(60).default(''),
  firstFollowUpAt: z.number().nullish(),
});

prospectingRouter.post(
  '/',
  requirePermission('prospect.write'),
  ah(async (req, res) => {
    const input = parseBody(createSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();

    if (!input.contactId && !input.newContact)
      throw badRequest('Provide either an existing contactId or newContact details.');

    const result = tx((t) => {
      let contactId = input.contactId ?? null;

      if (input.newContact) {
        // Duplicate prevention — the same person must never fork into two records.
        const nc = input.newContact;
        const dupe = t
          .prepare(
            `SELECT id, first_name, last_name FROM contacts
              WHERE archived_at IS NULL
                AND first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE
                AND (email = ? COLLATE NOCASE OR phone = ? OR mobile = ?)`,
          )
          .get(
            nc.firstName, nc.lastName,
            (nc.email ?? '').toLowerCase(), nc.phone ?? '', nc.mobile ?? '',
          );
        if (dupe) {
          throw conflict(
            `${(dupe as any).first_name} ${(dupe as any).last_name} already exists on file.`,
            { existingId: (dupe as any).id },
          );
        }
        contactId = newId('ct');
        t.prepare(
          `INSERT INTO contacts (id, company_id, first_name, last_name, title, email, phone, mobile,
             is_decision_maker, contact_pref, consent_sms, consent_email, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'phone', ?, ?, ?, ?, ?)`,
        ).run(
          contactId, input.companyId ?? null, nc.firstName, nc.lastName, nc.title,
          nc.email ?? null, nc.phone ?? null, nc.mobile ?? null,
          nc.isDecisionMaker ? 1 : 0, nc.consentSms ? 1 : 0, nc.consentEmail ? 1 : 0,
          actor.id, now(), now(),
        );
      } else {
        const found = contactId
          ? t.prepare('SELECT id FROM contacts WHERE id = ? AND archived_at IS NULL').get(contactId)
          : null;
        if (!found) throw notFound('Contact not found.');
      }

      const contact = t.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as any;
      const prospectId = newId('pro');
      const nextFollowup =
        input.firstFollowUpAt ??
        defaultFollowUp(input.timing, input.timingDate);

      t.prepare(
        `INSERT INTO prospects (id, contact_id, company_id, owner_id, stage, disposition_id,
           temperature, timing, timing_date, source_id, territory_id, scope_summary, project_address,
           next_followup_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        prospectId, contactId, input.companyId ?? contact.company_id ?? null,
        input.ownerId ?? actor.id, input.stage, input.dispositionId ?? null,
        input.temperature, input.timing, input.timingDate ?? null,
        input.sourceId ?? null, input.territoryId ?? null,
        input.scopeSummary, input.projectAddress, nextFollowup,
        actor.id, now(), now(),
      );

      // The opportunity is the thread that will travel through all four workspaces.
      const opportunityId = newId('opp');
      t.prepare(
        `INSERT INTO opportunities (id, prospect_id, contact_id, company_id, name, trade, scope_summary,
           project_address, stage, source_id, territory_id, owner_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prospect', ?, ?, ?, ?, ?, ?)`,
      ).run(
        opportunityId, prospectId, contactId, input.companyId ?? contact.company_id ?? null,
        input.opportunityName ?? `${contact.first_name} ${contact.last_name} — new opportunity`,
        input.trade, input.scopeSummary, input.projectAddress,
        input.sourceId ?? null, input.territoryId ?? null,
        input.ownerId ?? actor.id, actor.id, now(), now(),
      );

      return { prospectId, contactId, opportunityId };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'prospect.created',
      entityType: 'prospect', entityId: result.prospectId,
      summary: `Created prospect for contact ${result.contactId}`,
      after: { stage: input.stage, temperature: input.temperature, timing: input.timing },
    });

    res.status(201).json({
      row: db.prepare('SELECT * FROM prospects WHERE id = ?').get(result.prospectId),
      contactId: result.contactId,
      opportunityId: result.opportunityId,
    });
  }),
);

function defaultFollowUp(timing: string, timingDate?: number | null): number {
  if (timing === 'custom') return timingDate ?? now() + 30 * 86_400_000;
  const days = timing === 'within_2w' ? 7 : timing === 'within_month' ? 14 : 30;
  return now() + days * 86_400_000;
}

/* ------------------------------------------------------------------ */
/* Read + update                                                       */
/* ------------------------------------------------------------------ */

prospectingRouter.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT p.*, co.first_name AS contact_first, co.last_name AS contact_last,
                co.phone, co.mobile, co.email, co.is_decision_maker, co.consent_sms, co.opt_out_at,
                c.name AS company_name, d.name AS disposition_name,
                u.name AS owner_name, s.name AS source_name, t.name AS territory_name
           FROM prospects p
           JOIN contacts co ON co.id = p.contact_id
           LEFT JOIN companies c ON c.id = p.company_id
           LEFT JOIN dispositions d ON d.id = p.disposition_id
           LEFT JOIN users u ON u.id = p.owner_id
           LEFT JOIN lead_sources s ON s.id = p.source_id
           LEFT JOIN territories t ON t.id = p.territory_id
          WHERE p.id = ?`,
      )
      .get(req.params.id);
    if (!row) throw notFound('Prospect not found.');

    const tasks = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id = t.assignee_id
          WHERE t.prospect_id = ? ORDER BY t.due_at ASC`,
      )
      .all(req.params.id);
    const communications = db
      .prepare(
        `SELECT cm.*, u.name AS logged_by_name FROM communications cm
           LEFT JOIN users u ON u.id = cm.logged_by
          WHERE cm.prospect_id = ? ORDER BY cm.occurred_at DESC LIMIT 50`,
      )
      .all(req.params.id);
    const documents = db
      .prepare(`SELECT id, filename, kind, size, version, created_at FROM documents WHERE owner_type='prospect' AND owner_id = ?`)
      .all(req.params.id);
    const opportunity = db
      .prepare('SELECT * FROM opportunities WHERE prospect_id = ?')
      .get(req.params.id);

    res.json({ row, tasks, communications, documents, opportunity });
  }),
);

const updateSchema = z.object({
  stage: z.enum(STAGES).optional(),
  dispositionId: z.string().nullish(),
  temperature: z.enum(TEMPERATURES).optional(),
  timing: z.enum(TIMING).optional(),
  timingDate: z.number().nullish(),
  ownerId: z.string().nullish(),
  sourceId: z.string().nullish(),
  territoryId: z.string().nullish(),
  scopeSummary: z.string().trim().max(4000).optional(),
  projectAddress: z.string().trim().max(400).optional(),
  nextFollowupAt: z.number().nullish(),
});

prospectingRouter.patch(
  '/:id',
  requirePermission('prospect.write'),
  ah(async (req, res) => {
    const input = parseBody(updateSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Prospect not found.');
    if (before.archived_at) throw conflict('This prospect is archived.');

    if (input.dispositionId) {
      const d = db
        .prepare(`SELECT id, workspace FROM dispositions WHERE id = ? AND active = 1`)
        .get(input.dispositionId) as any;
      if (!d || d.workspace !== 'prospect') throw badRequest('That disposition is not available for prospects.');
    }

    db.prepare(
      `UPDATE prospects SET
         stage = COALESCE(?, stage),
         disposition_id = CASE WHEN @dispositionId_set THEN @dispositionId ELSE disposition_id END,
         temperature = COALESCE(?, temperature),
         timing = COALESCE(?, timing),
         timing_date = CASE WHEN @timingDate_set THEN @timingDate ELSE timing_date END,
         owner_id = COALESCE(?, owner_id),
         source_id = CASE WHEN @sourceId_set THEN @sourceId ELSE source_id END,
         territory_id = CASE WHEN @territoryId_set THEN @territoryId ELSE territory_id END,
         scope_summary = COALESCE(?, scope_summary),
         project_address = COALESCE(?, project_address),
         next_followup_at = CASE WHEN @nextFollowupAt_set THEN @nextFollowupAt ELSE next_followup_at END,
         updated_at = ?
       WHERE id = ?`,
    ).run({
      stage: input.stage ?? null,
      dispositionId: input.dispositionId ?? null,
      dispositionId_set: input.dispositionId !== undefined ? 1 : 0,
      temperature: input.temperature ?? null,
      timing: input.timing ?? null,
      timingDate: input.timingDate ?? null,
      timingDate_set: input.timingDate !== undefined ? 1 : 0,
      ownerId: input.ownerId ?? null,
      sourceId: input.sourceId ?? null,
      sourceId_set: input.sourceId !== undefined ? 1 : 0,
      territoryId: input.territoryId ?? null,
      territoryId_set: input.territoryId !== undefined ? 1 : 0,
      scopeSummary: input.scopeSummary ?? null,
      projectAddress: input.projectAddress ?? null,
      nextFollowupAt: input.nextFollowupAt ?? null,
      nextFollowupAt_set: input.nextFollowupAt !== undefined ? 1 : 0,
      updated_at: now(),
      id: req.params.id,
    });

    const after = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(after as any)) {
      if ((before as any)[k] !== v && !['updated_at'].includes(k)) changed[k] = { from: (before as any)[k], to: v };
    }
    if (Object.keys(changed).length) {
      audit({
        actorId: actor.id, actorName: actor.name, action: 'prospect.updated',
        entityType: 'prospect', entityId: req.params.id,
        summary: `Updated prospect`, before, after, meta: { changed: Object.keys(changed) },
      });
    }
    res.json({ row: after });
  }),
);

/** Kanban drag: stage moves are validated, not trusted from the client. */
prospectingRouter.post(
  '/:id/move',
  requirePermission('prospect.write'),
  ah(async (req, res) => {
    const input = parseBody(z.object({ stage: z.enum(STAGES) }), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Prospect not found.');
    if (before.archived_at) throw conflict('This prospect is archived.');
    if (before.stage === input.stage) return res.json({ row: before, unchanged: true });
    // Moving to `nurturing` must not silently drop an active pursuit back to
    // a raw prospect — no extra rule needed, but a backwards move is audited
    // with the direction so reporting can spot churn.
    const backwards = stageIndex(input.stage) < stageIndex(before.stage);

    db.prepare('UPDATE prospects SET stage = ?, updated_at = ? WHERE id = ?').run(
      input.stage, now(), req.params.id,
    );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'prospect.stage_changed',
      entityType: 'prospect', entityId: req.params.id,
      summary: `Moved ${before.stage} → ${input.stage}`,
      before: { stage: before.stage }, after: { stage: input.stage },
      meta: { backwards },
    });
    res.json({ row: db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* Handoff → Underwriting                                             */
/* ------------------------------------------------------------------ */

function handoffFacts(prospectId: string) {
  const db = getDb();
  const p = db
    .prepare(
      `SELECT p.*, co.first_name, co.last_name, co.phone, co.mobile, co.email, co.is_decision_maker,
              c.name AS company_name
         FROM prospects p JOIN contacts co ON co.id = p.contact_id
         LEFT JOIN companies c ON c.id = p.company_id
        WHERE p.id = ?`,
    )
    .get(prospectId) as any;
  if (!p) return null;

  const plans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
        WHERE (d.owner_type='prospect' AND d.owner_id=?) OR (d.owner_type='contact' AND d.owner_id=?)
          AND d.kind IN ('blueprint','attachment')`,
    )
    .get(prospectId, p.contact_id) as any;
  const siteVisit = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE prospect_id = ? AND type = 'site_visit' AND status = 'done'`,
    )
    .get(prospectId) as any;
  return { p, hasPlans: plans.n > 0, hasSiteVisit: siteVisit.n > 0 };
}

prospectingRouter.get(
  '/:id/qualification',
  ah(async (req, res) => {
    const facts = handoffFacts(req.params.id);
    if (!facts) throw notFound('Prospect not found.');
    const result = evaluateHandoffQualification({
      scopeSummary: facts.p.scope_summary ?? '',
      projectAddress: facts.p.project_address ?? '',
      contactPhone: facts.p.phone || facts.p.mobile ? (facts.p.phone ?? facts.p.mobile) : null,
      contactEmail: facts.p.email,
      isDecisionMaker: facts.p.is_decision_maker === 1,
      hasPlans: facts.hasPlans,
      hasSiteVisit: facts.hasSiteVisit,
      requireEvidence: false,
    });
    const alreadyBid = getDb()
      .prepare('SELECT id, bid_no FROM bids WHERE prospect_id = ?')
      .get(req.params.id);
    res.json({ ...result, existingBid: alreadyBid ?? null });
  }),
);

const handoffSchema = z.object({
  trade: z.string().trim().min(1).max(60),
  estimatorId: z.string().nullish(),
  quoteDueAt: z.number().nullish(),
  takeoffRequired: z.boolean().default(false),
  performMode: z.enum(['self', 'sub', 'mixed']).default('self'),
});

/**
 * Send a qualified prospect to Underwriting.
 *
 * Idempotent by construction: it never creates a second contact, a second
 * opportunity, or a second bid for the same prospect. Re-running it returns
 * the existing bid instead of duplicating records.
 */
prospectingRouter.post(
  '/:id/handoff',
  requirePermission('prospect.handoff'),
  ah(async (req, res) => {
    const input = parseBody(handoffSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();

    const facts = handoffFacts(req.params.id);
    if (!facts) throw notFound('Prospect not found.');
    if (facts.p.archived_at) throw conflict('This prospect is archived.');

    const qualification = evaluateHandoffQualification({
      scopeSummary: facts.p.scope_summary ?? '',
      projectAddress: facts.p.project_address ?? '',
      contactPhone: facts.p.phone || facts.p.mobile ? (facts.p.phone ?? facts.p.mobile) : null,
      contactEmail: facts.p.email,
      isDecisionMaker: facts.p.is_decision_maker === 1,
      hasPlans: facts.hasPlans,
      hasSiteVisit: facts.hasSiteVisit,
      requireEvidence: false,
    });
    if (!qualification.ok) {
      return res.status(422).json({
        error: {
          code: 'validation',
          message: 'This prospect is not ready for Underwriting yet.',
          details: { blockers: qualification.blockers, items: qualification.items },
        },
      });
    }

    const existing = db.prepare('SELECT * FROM bids WHERE prospect_id = ?').get(req.params.id) as any;
    if (existing) {
      return res.status(409).json({
        error: { code: 'conflict', message: `This prospect already has bid ${existing.bid_no}.` },
        bid: existing,
      });
    }

    const outcome = tx((t) => {
      // Reuse the prospect's opportunity rather than forking a new one.
      let opportunity = t
        .prepare('SELECT * FROM opportunities WHERE prospect_id = ?')
        .get(req.params.id) as any;
      if (!opportunity) {
        const oppId = newId('opp');
        t.prepare(
          `INSERT INTO opportunities (id, prospect_id, contact_id, company_id, name, trade, scope_summary,
             project_address, stage, source_id, territory_id, owner_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'underwriting', ?, ?, ?, ?, ?, ?)`,
        ).run(
          oppId, req.params.id, facts.p.contact_id, facts.p.company_id,
          `${facts.p.first_name} ${facts.p.last_name} — ${input.trade}`,
          input.trade, facts.p.scope_summary, facts.p.project_address,
          facts.p.source_id, facts.p.territory_id, facts.p.owner_id,
          actor.id, now(), now(),
        );
        opportunity = t.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId);
      } else {
        t.prepare(`UPDATE opportunities SET stage='underwriting', trade=?, updated_at=? WHERE id=?`).run(
          input.trade, now(), opportunity.id,
        );
      }

      const bidCount = (t.prepare('SELECT COUNT(*) AS n FROM bids').get() as any).n;
      const bidId = newId('bid');
      const bidNo = `BID-${String(bidCount + 1).padStart(4, '0')}`;

      t.prepare(
        `INSERT INTO bids (id, bid_no, opportunity_id, prospect_id, contact_id, company_id,
           project_address, trade, scope_summary, estimator_id, stage, temperature, quote_due_at,
           started_at, takeoff_required, perform_mode, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scope', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bidId, bidNo, opportunity.id, req.params.id, facts.p.contact_id, facts.p.company_id,
        facts.p.project_address, input.trade, facts.p.scope_summary,
        input.estimatorId ?? null, facts.p.temperature, input.quoteDueAt ?? null,
        now(), input.takeoffRequired ? 1 : 0, input.performMode, actor.id, now(), now(),
      );

      t.prepare(
        `UPDATE prospects SET handoff_at = ?, handoff_bid_id = ?, updated_at = ? WHERE id = ?`,
      ).run(now(), bidId, now(), req.params.id);

      return { bidId, bidNo, opportunityId: opportunity.id };
    });

    audit({
      actorId: actor.id, actorName: actor.name, action: 'prospect.handoff',
      entityType: 'prospect', entityId: req.params.id,
      summary: `Sent to Underwriting as ${outcome.bidNo}`,
      after: { bidId: outcome.bidId, bidNo: outcome.bidNo, trade: input.trade },
      meta: { qualification: 'passed' },
    });
    audit({
      actorId: actor.id, actorName: actor.name, action: 'bid.created',
      entityType: 'bid', entityId: outcome.bidId,
      summary: `${outcome.bidNo} created from prospect handoff`,
      meta: { from: 'prospecting', prospectId: req.params.id },
    });

    res.status(201).json({
      bid: db.prepare('SELECT * FROM bids WHERE id = ?').get(outcome.bidId),
      opportunityId: outcome.opportunityId,
      qualification,
    });
  }),
);

prospectingRouter.post(
  '/:id/archive',
  requirePermission('prospect.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const before = getDb().prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Prospect not found.');
    getDb().prepare('UPDATE prospects SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'prospect.archived',
      entityType: 'prospect', entityId: req.params.id, summary: 'Archived prospect',
    });
    res.json({ ok: true });
  }),
);
