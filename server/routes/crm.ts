import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, notFound, badRequest, parsePagination, page } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';

const companySchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['customer', 'gc', 'vendor', 'subcontractor', 'other']).default('customer'),
  territoryId: z.string().nullish(),
  website: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  address: z.string().trim().max(400).nullish(),
  notes: z.string().trim().max(5000).default(''),
});

const contactSchema = z.object({
  companyId: z.string().nullish(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  title: z.string().trim().max(120).default(''),
  email: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  mobile: z.string().trim().max(40).nullish(),
  isDecisionMaker: z.boolean().default(false),
  contactPref: z.enum(['phone', 'text', 'email']).default('phone'),
  consentSms: z.boolean().default(false),
  consentEmail: z.boolean().default(true),
  notes: z.string().trim().max(5000).default(''),
});

/* ================================================================== */
/* Companies                                                          */
/* ================================================================== */

export const companies = Router();
companies.use(requireAuth);

companies.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const q = String((req.query as any).q ?? '').trim();
    const kind = String((req.query as any).kind ?? '').trim();
    const archived = (req.query as any).archived === '1';

    const where: string[] = [archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
    const params: any[] = [];
    if (q) {
      where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM companies ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT c.*, t.name AS territory_name,
                (SELECT COUNT(*) FROM contacts co WHERE co.company_id = c.id AND co.archived_at IS NULL) AS contact_count
           FROM companies c
           LEFT JOIN territories t ON t.id = c.territory_id
           ${clause}
          ORDER BY c.name COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

companies.post(
  '/',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const input = parseBody(companySchema, req.body);
    const actor = currentUser(req);
    const id = newId('co');
    tx((db) => {
      db.prepare(
        `INSERT INTO companies (id, name, kind, territory_id, website, phone, email, address, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.name, input.kind, input.territoryId ?? null, input.website ?? null,
        input.phone ?? null, input.email ?? null, input.address ?? null, input.notes,
        actor.id, now(), now(),
      );
    });
    audit({
      actorId: actor.id, actorName: actor.name, action: 'company.created',
      entityType: 'company', entityId: id, summary: `Created company "${input.name}"`,
      after: input,
    });
    res.status(201).json({ row: getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) });
  }),
);

companies.get(
  '/:id',
  ah(async (req, res) => {
    const db = getDb();
    const row = must(
      db.prepare(
        `SELECT c.*, t.name AS territory_name FROM companies c
          LEFT JOIN territories t ON t.id = c.territory_id WHERE c.id = ?`,
      ).get(req.params.id),
      'Company',
    );
    const contacts = db
      .prepare('SELECT * FROM contacts WHERE company_id = ? AND archived_at IS NULL ORDER BY first_name')
      .all(req.params.id);
    res.json({ company: row, contacts });
  }),
);

companies.patch(
  '/:id',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const input = parseBody(companySchema.partial(), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Company not found.');
    const patch: any = {
      name: input.name ?? before.name,
      kind: input.kind ?? before.kind,
      territory_id: input.territoryId === undefined ? before.territory_id : input.territoryId,
      website: input.website === undefined ? before.website : input.website,
      phone: input.phone === undefined ? before.phone : input.phone,
      email: input.email === undefined ? before.email : input.email,
      address: input.address === undefined ? before.address : input.address,
      notes: input.notes ?? before.notes,
    };
    db.prepare(
      `UPDATE companies SET name=@name, kind=@kind, territory_id=@territory_id, website=@website,
        phone=@phone, email=@email, address=@address, notes=@notes, updated_at=@updated_at WHERE id=@id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });
    audit({
      actorId: actor.id, actorName: actor.name, action: 'company.updated',
      entityType: 'company', entityId: req.params.id,
      summary: `Updated "${before.name}"`,
      before, after: patch,
    });
    res.json({ row: db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id) });
  }),
);

companies.post(
  '/:id/archive',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Company not found.');
    db.prepare('UPDATE companies SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'company.archived',
      entityType: 'company', entityId: req.params.id, summary: `Archived "${before.name}"`,
    });
    res.json({ ok: true });
  }),
);

/* ================================================================== */
/* Contacts + the unified contact card                                */
/* ================================================================== */

export const contacts = Router();
contacts.use(requireAuth);

contacts.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const q = String((req.query as any).q ?? '').trim();
    const companyId = String((req.query as any).companyId ?? '').trim();
    const where: string[] = ['co.archived_at IS NULL'];
    const params: any[] = [];
    if (q) {
      where.push('(co.first_name LIKE ? OR co.last_name LIKE ? OR co.email LIKE ? OR co.phone LIKE ? OR co.mobile LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (companyId) {
      where.push('co.company_id = ?');
      params.push(companyId);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM contacts co ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT co.id, co.first_name, co.last_name, co.title, co.email, co.phone, co.mobile,
                co.is_decision_maker, co.consent_sms, co.company_id, c.name AS company_name,
                (SELECT COUNT(*) FROM prospects p WHERE p.contact_id = co.id AND p.archived_at IS NULL) AS prospect_count,
                (SELECT COUNT(*) FROM projects pr WHERE pr.contact_id = co.id) AS project_count
           FROM contacts co
           LEFT JOIN companies c ON c.id = co.company_id
           ${clause}
          ORDER BY co.last_name COLLATE NOCASE, co.first_name COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

contacts.post(
  '/',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const input = parseBody(contactSchema, req.body);
    const actor = currentUser(req);
    // Duplicate prevention: same name + phone or email already on file.
    const db = getDb();
    const dupe = db
      .prepare(
        `SELECT id, first_name, last_name FROM contacts
          WHERE archived_at IS NULL
            AND first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE
            AND ((? IS NOT NULL AND (? != '' AND (phone = ? OR mobile = ?)))
              OR (? IS NOT NULL AND ? != '' AND email = ? COLLATE NOCASE))
          LIMIT 1`,
      )
      .get(
        input.firstName, input.lastName,
        input.phone ?? null, input.phone ?? '', input.phone ?? '', input.phone ?? '',
        input.email ?? null, input.email ?? '', input.email ?? '',
      );
    if (dupe) {
      throw badRequest(
        `A contact named ${(dupe as any).first_name} ${(dupe as any).last_name} already exists with that phone or email.`,
        { existingId: (dupe as any).id },
      );
    }

    const id = newId('ct');
    db.prepare(
      `INSERT INTO contacts (id, company_id, first_name, last_name, title, email, phone, mobile,
         is_decision_maker, contact_pref, consent_sms, consent_email, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.companyId ?? null, input.firstName, input.lastName, input.title,
      input.email ?? null, input.phone ?? null, input.mobile ?? null,
      input.isDecisionMaker ? 1 : 0, input.contactPref,
      input.consentSms ? 1 : 0, input.consentEmail ? 1 : 0,
      input.notes, actor.id, now(), now(),
    );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'contact.created',
      entityType: 'contact', entityId: id,
      summary: `Created contact ${input.firstName} ${input.lastName}`, after: input,
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) });
  }),
);

/**
 * The unified contact card: one aggregated read across every workspace.
 * Nothing here is duplicated — every section is a live query over the
 * records that already exist.
 */
contacts.get(
  '/:id/card',
  ah(async (req, res) => {
    const db = getDb();
    const contact = db
      .prepare(
        `SELECT co.*, c.name AS company_name, c.kind AS company_kind
           FROM contacts co LEFT JOIN companies c ON c.id = co.company_id
          WHERE co.id = ?`,
      )
      .get(req.params.id) as any;
    if (!contact) throw notFound('Contact not found.');
    const id = req.params.id;

    const prospects = db
      .prepare(
        `SELECT p.id, p.stage, p.temperature, p.timing, p.next_followup_at, p.last_contact_at,
                p.scope_summary, p.project_address, p.created_at,
                d.name AS disposition_name, u.name AS owner_name, s.name AS source_name
           FROM prospects p
           LEFT JOIN dispositions d ON d.id = p.disposition_id
           LEFT JOIN users u ON u.id = p.owner_id
           LEFT JOIN lead_sources s ON s.id = p.source_id
          WHERE p.contact_id = ? AND p.archived_at IS NULL
          ORDER BY p.created_at DESC`,
      )
      .all(id);

    const bids = db
      .prepare(
        `SELECT b.id, b.bid_no, b.trade, b.stage, b.quote_due_at, b.started_at, b.project_address,
                b.scope_summary, d.name AS disposition_name, u.name AS estimator_name
           FROM bids b
           LEFT JOIN dispositions d ON d.id = b.disposition_id
           LEFT JOIN users u ON u.id = b.estimator_id
          WHERE b.contact_id = ? AND b.archived_at IS NULL
          ORDER BY b.started_at DESC`,
      )
      .all(id);

    const deals = db
      .prepare(
        `SELECT d.id, d.deal_no, d.project_name, d.value, d.stage, d.expected_close_at,
                d.created_at, u.name AS closer_name
           FROM deals d LEFT JOIN users u ON u.id = d.closer_id
          WHERE d.contact_id = ? AND d.archived_at IS NULL
          ORDER BY d.created_at DESC`,
      )
      .all(id);

    const contracts = db
      .prepare(
        `SELECT ct.id, ct.version, ct.amount, ct.status, ct.signature_status, ct.signed_at, d.deal_no
           FROM contracts ct JOIN deals d ON d.id = ct.deal_id
          WHERE d.contact_id = ? ORDER BY ct.signed_at DESC NULLS LAST`,
      )
      .all(id);

    const projects = db
      .prepare(
        `SELECT p.id, p.project_no, p.name, p.status, p.address, p.original_contract,
                p.change_order_total, p.started_at
           FROM projects p WHERE p.contact_id = ? ORDER BY p.created_at DESC`,
      )
      .all(id);

    const communications = db
      .prepare(
        `SELECT cm.id, cm.channel, cm.direction, cm.status, cm.subject, cm.body, cm.outcome,
                cm.occurred_at, cm.test_mode, u.name AS logged_by_name
           FROM communications cm LEFT JOIN users u ON u.id = cm.logged_by
          WHERE cm.contact_id = ? ORDER BY cm.occurred_at DESC LIMIT 60`,
      )
      .all(id);

    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.type, t.status, t.due_at, t.priority, t.notes, u.name AS assignee_name
           FROM tasks t JOIN users u ON u.id = t.assignee_id
          WHERE t.contact_id = ? AND t.status = 'open'
          ORDER BY t.due_at ASC LIMIT 50`,
      )
      .all(id);

    const documents = db
      .prepare(
        `SELECT id, filename, kind, size, version, created_at FROM documents
          WHERE (owner_type = 'contact' AND owner_id = ?)
          ORDER BY created_at DESC LIMIT 50`,
      )
      .all(id);

    const activity = db
      .prepare(
        `SELECT id, action, entity_type, entity_id, summary, actor_name, at
           FROM audit_events
          WHERE (entity_type = 'contact' AND entity_id = ?)
             OR entity_id IN (SELECT id FROM prospects WHERE contact_id = ?)
             OR entity_id IN (SELECT id FROM bids WHERE contact_id = ?)
             OR entity_id IN (SELECT id FROM deals WHERE contact_id = ?)
             OR entity_id IN (SELECT id FROM projects WHERE contact_id = ?)
          ORDER BY at DESC LIMIT 60`,
      )
      .all(id, id, id, id, id);

    res.json({
      contact,
      prospects,
      bids,
      deals,
      contracts,
      projects,
      communications,
      tasks,
      documents,
      activity,
      counts: {
        prospects: prospects.length,
        bids: bids.length,
        deals: deals.length,
        projects: projects.length,
        openTasks: tasks.length,
        communications: communications.length,
      },
    });
  }),
);

contacts.get(
  '/:id',
  ah(async (req, res) => {
    const row = getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
    if (!row) throw notFound('Contact not found.');
    res.json({ row });
  }),
);

contacts.patch(
  '/:id',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const input = parseBody(contactSchema.partial(), req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Contact not found.');

    db.prepare(
      `UPDATE contacts SET
        company_id = @company_id, first_name = @first_name, last_name = @last_name,
        title = @title, email = @email, phone = @phone, mobile = @mobile,
        is_decision_maker = @is_decision_maker, contact_pref = @contact_pref,
        consent_sms = @consent_sms, consent_email = @consent_email, notes = @notes,
        opt_out_at = @opt_out_at, updated_at = @updated_at
      WHERE id = @id`,
    ).run({
      id: req.params.id,
      company_id: input.companyId === undefined ? before.company_id : input.companyId,
      first_name: input.firstName ?? before.first_name,
      last_name: input.lastName ?? before.last_name,
      title: input.title ?? before.title,
      email: input.email === undefined ? before.email : input.email,
      phone: input.phone === undefined ? before.phone : input.phone,
      mobile: input.mobile === undefined ? before.mobile : input.mobile,
      is_decision_maker: input.isDecisionMaker === undefined ? before.is_decision_maker : input.isDecisionMaker ? 1 : 0,
      contact_pref: input.contactPref ?? before.contact_pref,
      consent_sms: input.consentSms === undefined ? before.consent_sms : input.consentSms ? 1 : 0,
      consent_email: input.consentEmail === undefined ? before.consent_email : input.consentEmail ? 1 : 0,
      notes: input.notes ?? before.notes,
      // Opting out is sticky: once set it can only be cleared explicitly.
      opt_out_at: input.consentSms === true ? null : before.opt_out_at,
      updated_at: now(),
    });

    // Consent changes are recorded on every communication they gate.
    if (input.consentSms !== undefined && (input.consentSms ? 1 : 0) !== before.consent_sms) {
      audit({
        actorId: actor.id, actorName: actor.name, action: 'contact.consent_changed',
        entityType: 'contact', entityId: req.params.id,
        summary: input.consentSms ? 'SMS consent granted' : 'SMS consent withdrawn',
        before: { consent_sms: before.consent_sms }, after: { consent_sms: input.consentSms ? 1 : 0 },
      });
    }

    const after = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'contact.updated',
      entityType: 'contact', entityId: req.params.id,
      summary: `Updated ${before.first_name} ${before.last_name}`, before, after,
    });
    res.json({ row: after });
  }),
);

contacts.post(
  '/:id/archive',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Contact not found.');
    db.prepare('UPDATE contacts SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), req.params.id);
    audit({
      actorId: actor.id, actorName: actor.name, action: 'contact.archived',
      entityType: 'contact', entityId: req.params.id,
      summary: `Archived ${before.first_name} ${before.last_name}`,
    });
    res.json({ ok: true });
  }),
);

/* ================================================================== */
/* Opportunities — the thread across all four workspaces              */
/* ================================================================== */

export const opportunities = Router();
opportunities.use(requireAuth);

opportunities.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 25);
    const stage = String((req.query as any).stage ?? '').trim();
    const where: string[] = ['o.archived_at IS NULL'];
    const params: any[] = [];
    if (stage) { where.push('o.stage = ?'); params.push(stage); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM opportunities o ${clause}`).get(...params) as any).n;
    const rows = getDb()
      .prepare(
        `SELECT o.*, co.first_name || ' ' || co.last_name AS contact_name, c.name AS company_name
           FROM opportunities o
           JOIN contacts co ON co.id = o.contact_id
           LEFT JOIN companies c ON c.id = o.company_id
           ${clause} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const opportunitySchema = z.object({
  prospectId: z.string().nullish(),
  contactId: z.string().min(1),
  companyId: z.string().nullish(),
  name: z.string().trim().min(1).max(200),
  trade: z.string().trim().max(60).default(''),
  scopeSummary: z.string().trim().max(4000).default(''),
  projectAddress: z.string().trim().max(400).default(''),
  estimatedValue: z.number().nonnegative().nullish(),
});

opportunities.post(
  '/',
  requirePermission('crm.write'),
  ah(async (req, res) => {
    const input = parseBody(opportunitySchema, req.body);
    const actor = currentUser(req);
    const id = newId('opp');
    getDb()
      .prepare(
        `INSERT INTO opportunities (id, prospect_id, contact_id, company_id, name, trade, scope_summary,
           project_address, estimated_value, stage, owner_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect', ?, ?, ?, ?)`,
      )
      .run(
        id, input.prospectId ?? null, input.contactId, input.companyId ?? null, input.name,
        input.trade, input.scopeSummary, input.projectAddress, input.estimatedValue ?? null,
        actor.id, actor.id, now(), now(),
      );
    audit({
      actorId: actor.id, actorName: actor.name, action: 'opportunity.created',
      entityType: 'opportunity', entityId: id, summary: `Created opportunity "${input.name}"`,
    });
    res.status(201).json({ row: getDb().prepare('SELECT * FROM opportunities WHERE id = ?').get(id) });
  }),
);
