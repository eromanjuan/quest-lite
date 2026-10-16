import { Router } from 'express';
import { z } from 'zod';
import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser } from '../auth/middleware.js';
import { ah, parseBody, must, parsePagination, page } from '../http/helpers.js';
import { conflict, validationError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';
import { readSetting } from './config.js';

export const commsRouter = Router();
commsRouter.use(requireAuth);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface CommSettings {
  force_test_mode?: boolean;
  provider?: string;
  second_attempt_hours?: number;
  no_answer_callback_hours?: number;
}

const DEFAULT_COMM_SETTINGS: CommSettings = {
  force_test_mode: true,
  provider: 'none',
  second_attempt_hours: 4,
  no_answer_callback_hours: 3,
};

interface Delivery {
  provider: string;
  testMode: boolean;
  canSend: boolean;
}

/**
 * The single source of truth for what the app may claim about delivery.
 * A message can be recorded as sent only when ALL of these hold:
 * force_test_mode is off, the provider is not 'none', and an API key is
 * configured for the channel. Anything else is test mode: status='draft',
 * test_mode=1, and the response says draft — never "sent".
 * Calls, notes and meetings are human-recorded events, never provider sends.
 */
export function resolveDelivery(channel: string): Delivery {
  if (channel !== 'text' && channel !== 'email') {
    return { provider: 'manual', testMode: false, canSend: false };
  }
  const cfg = readSetting<CommSettings>('communications', DEFAULT_COMM_SETTINGS);
  const envProvider = ((
    channel === 'text' ? process.env.SMS_PROVIDER : process.env.EMAIL_PROVIDER
  ) ?? '').trim();
  const apiKey = ((channel === 'text' ? process.env.SMS_API_KEY : process.env.EMAIL_API_KEY) ?? '').trim();
  const provider = envProvider || (cfg.provider ?? '').trim() || 'none';
  const canSend = cfg.force_test_mode === false && provider !== 'none' && apiKey !== '';
  return { provider, testMode: !canSend, canSend };
}

/** Status for a brand-new outbound record — draft unless a live provider could send it. */
function outboundStatus(channel: string, delivery: Delivery): string {
  if (channel !== 'text' && channel !== 'email') return 'logged';
  return delivery.canSend ? 'sent' : 'draft';
}

function deliveryNotice(status: string, delivery: Delivery): string {
  if (status === 'draft') {
    return 'Recorded as a draft in test mode — no live provider is configured, so nothing was actually sent.';
  }
  if (status === 'sent') {
    return `Sent through ${delivery.provider}.`;
  }
  return 'Logged as a manual record — the app did not send anything through a provider.';
}

function contactName(contact: any): string {
  return `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() || 'this contact';
}

/** Throws 422 before anything is inserted when the contact has not consented. */
function assertConsent(channel: string, contact: any): void {
  if (channel === 'text') {
    if (!contact.consent_sms) {
      throw validationError(
        `${contactName(contact)} has not consented to text messages.`,
        [{ path: 'contactId', message: 'SMS consent is required.' }],
      );
    }
    if (contact.opt_out_at) {
      throw validationError(
        `${contactName(contact)} opted out of text messages and cannot be texted.`,
        [{ path: 'contactId', message: 'Contact has opted out of SMS.' }],
      );
    }
  }
  if (channel === 'email' && !contact.consent_email) {
    throw validationError(
      `${contactName(contact)} has not consented to email.`,
      [{ path: 'contactId', message: 'Email consent is required.' }],
    );
  }
}

/** Replaces known placeholders and leaves unknown ones (e.g. {link.photos}) intact. */
function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{([a-z0-9_.]+)\}/gi, (token, key) =>
    key in vars ? vars[key] : token,
  );
}

function templateVars(contact: any, senderName: string): Record<string, string> {
  return {
    'contact.first_name': contact?.first_name ?? '',
    'contact.last_name': contact?.last_name ?? '',
    'sender.name': senderName,
    'sender.first_name': senderName.split(/\s+/)[0] ?? senderName,
  };
}

interface CampaignStep {
  dayOffset: number;
  templateId: string;
  channel: string;
}

function parseSteps(raw: unknown): CampaignStep[] {
  if (typeof raw !== 'string') return Array.isArray(raw) ? (raw as CampaignStep[]) : [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shapeCampaign(row: any) {
  return { ...row, steps: parseSteps(row.steps) };
}

function stepTemplateErrors(steps: CampaignStep[]) {
  const db = getDb();
  const errors: Array<{ path: string; message: string }> = [];
  steps.forEach((step, i) => {
    if (!db.prepare('SELECT id FROM communication_templates WHERE id = ?').get(step.templateId)) {
      errors.push({ path: `steps.${i}.templateId`, message: 'That template does not exist.' });
    }
  });
  return errors;
}

/* ================================================================== */
/* Reads                                                              */
/* ================================================================== */

commsRouter.get(
  '/',
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req);
    const query = req.query as any;
    const where: string[] = [];
    const params: any[] = [];

    const links = [
      ['contactId', 'cm.contact_id'],
      ['prospectId', 'cm.prospect_id'],
      ['bidId', 'cm.bid_id'],
      ['dealId', 'cm.deal_id'],
      ['projectId', 'cm.project_id'],
      ['jobId', 'cm.job_id'],
      ['channel', 'cm.channel'],
      ['campaignId', 'cm.campaign_id'],
    ] as const;
    for (const [key, column] of links) {
      const value = String(query[key] ?? '').trim();
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    for (const [key, column, op] of [
      ['from', 'cm.occurred_at', '>='],
      ['to', 'cm.occurred_at', '<='],
    ] as const) {
      const raw = String(query[key] ?? '').trim();
      const n = raw === '' ? NaN : Number(raw);
      if (Number.isFinite(n)) {
        where.push(`${column} ${op} ?`);
        params.push(n);
      }
    }
    const search = String(query.q ?? '').trim();
    if (search) {
      where.push('(cm.subject LIKE ? OR cm.body LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = getDb();
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM communications cm ${clause}`).get(...params) as any
    ).n;
    const rows = db
      .prepare(
        `SELECT cm.*, u.name AS logged_by_name
           FROM communications cm LEFT JOIN users u ON u.id = cm.logged_by
           ${clause}
          ORDER BY cm.occurred_at DESC, cm.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

commsRouter.get(
  '/contact/:contactId',
  ah(async (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT cm.*, u.name AS logged_by_name
           FROM communications cm LEFT JOIN users u ON u.id = cm.logged_by
          WHERE cm.contact_id = ?
          ORDER BY cm.occurred_at DESC
          LIMIT 200`,
      )
      .all(req.params.contactId);
    res.json({ rows });
  }),
);

commsRouter.get(
  '/templates',
  ah(async (_req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM communication_templates ORDER BY category, name')
      .all();
    res.json({ rows });
  }),
);

/* ================================================================== */
/* Logging calls, texts, emails and notes                              */
/* ================================================================== */

const channelSchema = z.enum(['call', 'text', 'email', 'note', 'meeting']);

const logSchema = z.object({
  channel: channelSchema,
  direction: z.enum(['outbound', 'inbound', 'internal']).optional(),
  subject: z.string().trim().max(300).default(''),
  body: z.string().trim().max(20000).default(''),
  outcome: z.string().trim().max(60).nullish(),
  durationSec: z.number().int().min(0).nullish(),
  contactId: z.string().nullish(),
  prospectId: z.string().nullish(),
  opportunityId: z.string().nullish(),
  bidId: z.string().nullish(),
  dealId: z.string().nullish(),
  projectId: z.string().nullish(),
  jobId: z.string().nullish(),
  templateId: z.string().nullish(),
  occurredAt: z.number().nullish(),
});

commsRouter.post(
  '/log',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const input = parseBody(logSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();

    const contact = input.contactId
      ? must(db.prepare('SELECT * FROM contacts WHERE id = ?').get(input.contactId) as any, 'Contact')
      : undefined;
    if ((input.channel === 'text' || input.channel === 'email') && !contact) {
      throw validationError(
        'A text or email must be linked to a contact so consent can be verified.',
        [{ path: 'contactId', message: 'Required for text and email.' }],
      );
    }
    if (contact) assertConsent(input.channel, contact);

    // Guard against dangling FK references (they would surface as a 500).
    const links: Array<[string | null | undefined, string, string]> = [
      [input.prospectId, 'SELECT id FROM prospects WHERE id = ?', 'Prospect'],
      [input.opportunityId, 'SELECT id FROM opportunities WHERE id = ?', 'Opportunity'],
      [input.templateId, 'SELECT id FROM communication_templates WHERE id = ?', 'Template'],
    ];
    for (const [value, sql, label] of links) {
      if (value) must(db.prepare(sql).get(value), label);
    }

    const direction =
      input.direction ??
      (input.channel === 'note' || input.channel === 'meeting' ? 'internal' : 'outbound');
    const delivery = resolveDelivery(input.channel);
    // The app never sends from this endpoint, so a message under a live
    // provider is a manual record ('logged'); without one it stays a draft.
    const status =
      (input.channel === 'text' || input.channel === 'email') &&
      direction === 'outbound' &&
      !delivery.canSend
        ? 'draft'
        : 'logged';
    const occurredAt = input.occurredAt ?? now();

    const id = newId('cm');
    db.prepare(
      `INSERT INTO communications
        (id, channel, direction, status, subject, body, outcome, provider, test_mode,
         consent_ok, duration_sec, contact_id, company_id, prospect_id, opportunity_id,
         bid_id, deal_id, project_id, job_id, template_id, campaign_id, logged_by,
         occurred_at, created_at)
       VALUES
        (@id, @channel, @direction, @status, @subject, @body, @outcome, @provider, @test_mode,
         @consent_ok, @duration_sec, @contact_id, @company_id, @prospect_id, @opportunity_id,
         @bid_id, @deal_id, @project_id, @job_id, @template_id, @campaign_id, @logged_by,
         @occurred_at, @created_at)`,
    ).run({
      id,
      channel: input.channel,
      direction,
      status,
      subject: input.subject,
      body: input.body,
      outcome: input.outcome ?? null,
      provider: delivery.provider,
      test_mode: delivery.testMode ? 1 : 0,
      consent_ok: 1,
      duration_sec: input.durationSec ?? null,
      contact_id: input.contactId ?? null,
      company_id: contact ? (contact.company_id ?? null) : null,
      prospect_id: input.prospectId ?? null,
      opportunity_id: input.opportunityId ?? null,
      bid_id: input.bidId ?? null,
      deal_id: input.dealId ?? null,
      project_id: input.projectId ?? null,
      job_id: input.jobId ?? null,
      template_id: input.templateId ?? null,
      campaign_id: null,
      logged_by: actor.id,
      occurred_at: occurredAt,
      created_at: now(),
    });

    if (input.contactId) {
      db.prepare(
        `UPDATE prospects SET last_contact_at = ?
          WHERE contact_id = ? AND archived_at IS NULL`,
      ).run(occurredAt, input.contactId);
    }

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'communication.logged',
      entityType: 'communication',
      entityId: id,
      summary: contact
        ? `Logged ${input.channel} with ${contactName(contact)}`
        : `Logged ${input.channel}`,
      after: input,
    });
    res.status(201).json({
      row: db.prepare('SELECT * FROM communications WHERE id = ?').get(id),
      delivery: {
        provider: delivery.provider,
        testMode: delivery.testMode,
        status,
        notice: deliveryNotice(status, delivery),
      },
    });
  }),
);

const callSchema = z.object({
  contactId: z.string().min(1),
  outcome: z.enum([
    'connected',
    'no_answer',
    'voicemail',
    'callback_requested',
    'not_interested',
    'wrong_number',
    'left_voicemail',
  ]),
  notes: z.string().trim().max(10000).default(''),
  durationSec: z.number().int().min(0).nullish(),
  prospectId: z.string().nullish(),
  occurredAt: z.number().nullish(),
});

commsRouter.post(
  '/call',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const input = parseBody(callSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const contact = must(
      db.prepare('SELECT * FROM contacts WHERE id = ?').get(input.contactId) as any,
      'Contact',
    );

    let prospect: any = null;
    if (input.prospectId) {
      prospect = must(
        db.prepare('SELECT * FROM prospects WHERE id = ?').get(input.prospectId) as any,
        'Prospect',
      );
      if (prospect.contact_id !== contact.id) {
        throw validationError('That prospect does not belong to this contact.', [
          { path: 'prospectId', message: 'Prospect belongs to a different contact.' },
        ]);
      }
    }

    const occurredAt = input.occurredAt ?? now();
    const delivery = resolveDelivery('call');
    const id = newId('cm');
    db.prepare(
      `INSERT INTO communications
        (id, channel, direction, status, subject, body, outcome, provider, test_mode,
         consent_ok, duration_sec, contact_id, company_id, prospect_id, logged_by,
         occurred_at, created_at)
       VALUES
        (?, 'call', 'outbound', 'logged', '', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.notes,
      input.outcome,
      delivery.provider,
      delivery.testMode ? 1 : 0,
      input.durationSec ?? null,
      contact.id,
      contact.company_id ?? null,
      prospect ? prospect.id : null,
      actor.id,
      occurredAt,
      now(),
    );

    if (input.outcome === 'connected') {
      if (prospect) {
        db.prepare('UPDATE prospects SET last_contact_at = ? WHERE id = ?').run(
          occurredAt,
          prospect.id,
        );
      } else {
        // A connected call only advances the pipeline when the link is unambiguous.
        const open = db
          .prepare('SELECT id FROM prospects WHERE contact_id = ? AND archived_at IS NULL')
          .all(contact.id) as any[];
        if (open.length === 1) {
          db.prepare('UPDATE prospects SET last_contact_at = ? WHERE id = ?').run(
            occurredAt,
            open[0].id,
          );
        }
      }
    }

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'communication.call_logged',
      entityType: 'communication',
      entityId: id,
      summary: `Logged call (${input.outcome}) with ${contactName(contact)}`,
      after: { contactId: contact.id, outcome: input.outcome, prospectId: prospect?.id ?? null },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM communications WHERE id = ?').get(id) });
  }),
);

const noAnswerTextSchema = z.object({
  contactId: z.string().min(1),
  prospectId: z.string().nullish(),
  attempt: z.coerce.number().int().min(1).max(2),
  templateKey: z.string().trim().min(1).optional(),
  senderName: z.string().trim().min(1).max(120).optional(),
  logCallAttempt: z.boolean().default(false),
});

commsRouter.post(
  '/no-answer-text',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const input = parseBody(noAnswerTextSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();

    const contact = must(
      db.prepare('SELECT * FROM contacts WHERE id = ?').get(input.contactId) as any,
      'Contact',
    );
    assertConsent('text', contact);

    let prospect: any = null;
    if (input.prospectId) {
      prospect = must(
        db.prepare('SELECT * FROM prospects WHERE id = ?').get(input.prospectId) as any,
        'Prospect',
      );
      if (prospect.contact_id !== contact.id) {
        throw validationError('That prospect does not belong to this contact.', [
          { path: 'prospectId', message: 'Prospect belongs to a different contact.' },
        ]);
      }
    }

    const settings = readSetting<CommSettings>('communications', DEFAULT_COMM_SETTINGS);
    const templateKey =
      input.templateKey ?? (input.attempt === 1 ? 'no_answer_first' : 'no_answer_second');
    const template = must(
      db.prepare('SELECT * FROM communication_templates WHERE key = ?').get(templateKey) as any,
      'Communication template',
    );

    // Duplicate prevention: one no-answer text per contact per template inside
    // the cool-down window — second_attempt_hours for the first attempt (the
    // configured gap before a retry is allowed), 24h for the second.
    const windowHours =
      input.attempt === 1 ? (settings.second_attempt_hours ?? 4) : 24;
    const since = now() - windowHours * HOUR_MS;
    const recent = db
      .prepare(
        `SELECT * FROM communications
          WHERE contact_id = ? AND template_id = ? AND channel = 'text' AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(contact.id, template.id, since) as any;
    if (recent) {
      res.status(409).json({
        error: {
          code: 'conflict',
          message: 'A no-answer text was already sent for this contact recently.',
        },
        recent,
      });
      return;
    }

    const senderName = input.senderName ?? actor.name;
    const body = renderTemplate(template.body ?? '', templateVars(contact, senderName));
    const subject = renderTemplate(template.subject ?? '', templateVars(contact, senderName));

    const delivery = resolveDelivery('text');
    const status = outboundStatus('text', delivery);
    const at = now();

    // Attempt 1: call back after no_answer_callback_hours (default 3h).
    // Attempt 2: the second text already goes out later the same day, so the
    // follow-up call is booked for the next day, at the same hour.
    const callbackHours =
      input.attempt === 1 ? (settings.no_answer_callback_hours ?? 3) : 24;
    const callbackDueAt = at + callbackHours * HOUR_MS;
    const taskTitle = `Callback: ${contactName(contact)}`;

    const ids = tx((d) => {
      const commId = newId('cm');
      d.prepare(
        `INSERT INTO communications
          (id, channel, direction, status, subject, body, outcome, provider, test_mode,
           consent_ok, contact_id, company_id, prospect_id, template_id, logged_by,
           occurred_at, created_at)
         VALUES
          (?, 'text', 'outbound', ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        commId,
        status,
        subject,
        body,
        delivery.provider,
        delivery.testMode ? 1 : 0,
        contact.id,
        contact.company_id ?? null,
        prospect ? prospect.id : null,
        template.id,
        actor.id,
        at,
        at,
      );

      const taskId = newId('tsk');
      d.prepare(
        `INSERT INTO tasks
          (id, title, notes, type, assignee_id, due_at, status, priority,
           contact_id, prospect_id, created_by, created_at, updated_at)
         VALUES
          (?, ?, ?, 'call', ?, ?, 'open', 0, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        taskTitle,
        `No-answer text (attempt ${input.attempt}) recorded — follow up by phone.`,
        actor.id,
        callbackDueAt,
        contact.id,
        prospect ? prospect.id : null,
        actor.id,
        at,
        at,
      );

      let callAttemptId: string | null = null;
      if (input.logCallAttempt) {
        callAttemptId = newId('cm');
        d.prepare(
          `INSERT INTO communications
            (id, channel, direction, status, subject, body, outcome, provider, test_mode,
             consent_ok, contact_id, company_id, prospect_id, logged_by, occurred_at, created_at)
           VALUES
            (?, 'call', 'outbound', 'logged', '', '', 'no_answer', 'manual', 0, 1,
             ?, ?, ?, ?, ?, ?)`,
        ).run(
          callAttemptId,
          contact.id,
          contact.company_id ?? null,
          prospect ? prospect.id : null,
          actor.id,
          at,
          at,
        );
      }
      return { commId, taskId, callAttemptId };
    });

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'communication.no_answer_text',
      entityType: 'communication',
      entityId: ids.commId,
      summary: `No-answer text (attempt ${input.attempt}) to ${contactName(contact)} recorded as ${status}`,
      meta: { attempt: input.attempt, testMode: delivery.testMode, templateKey },
    });

    const communication = db
      .prepare('SELECT * FROM communications WHERE id = ?')
      .get(ids.commId);
    const nextCallbackTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(ids.taskId);
    const response: any = {
      communication,
      nextCallbackTask,
      delivery: {
        provider: delivery.provider,
        testMode: delivery.testMode,
        status,
        notice: deliveryNotice(status, delivery),
      },
    };
    if (ids.callAttemptId) {
      response.callAttempt = db
        .prepare('SELECT * FROM communications WHERE id = ?')
        .get(ids.callAttemptId);
    }
    res.status(201).json(response);
  }),
);

/* ================================================================== */
/* Templates                                                          */
/* ================================================================== */

const templateSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  name: z.string().trim().min(1).max(120),
  channel: z.string().trim().min(1).max(40),
  category: z.string().trim().max(60).default('general'),
  subject: z.string().trim().max(300).default(''),
  body: z.string().trim().min(1).max(20000),
});

commsRouter.post(
  '/templates',
  requirePermission('template.manage'),
  ah(async (req, res) => {
    const input = parseBody(templateSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    if (db.prepare('SELECT id FROM communication_templates WHERE key = ?').get(input.key)) {
      throw conflict('A template with that key already exists.');
    }
    const id = newId('tpl');
    const at = now();
    db.prepare(
      `INSERT INTO communication_templates
        (id, key, name, channel, category, subject, body, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      input.key,
      input.name,
      input.channel,
      input.category,
      input.subject,
      input.body,
      actor.id,
      at,
      at,
    );
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'template.created',
      entityType: 'template',
      entityId: id,
      summary: `Created template "${input.name}" (${input.key})`,
      after: input,
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM communication_templates WHERE id = ?').get(id) });
  }),
);

const templatePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  channel: z.string().trim().min(1).max(40).optional(),
  category: z.string().trim().max(60).optional(),
  subject: z.string().trim().max(300).optional(),
  body: z.string().trim().min(1).max(20000).optional(),
  active: z.boolean().optional(),
});

commsRouter.patch(
  '/templates/:id',
  requirePermission('template.manage'),
  ah(async (req, res) => {
    const input = parseBody(templatePatchSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM communication_templates WHERE id = ?').get(req.params.id) as any,
      'Template',
    );

    const patch: any = {
      name: input.name ?? before.name,
      channel: input.channel ?? before.channel,
      category: input.category ?? before.category,
      subject: input.subject ?? before.subject,
      body: input.body ?? before.body,
      active: input.active === undefined ? before.active : input.active ? 1 : 0,
    };
    db.prepare(
      `UPDATE communication_templates SET
         name = @name, channel = @channel, category = @category, subject = @subject,
         body = @body, active = @active, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM communication_templates WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'template.updated',
      entityType: 'template',
      entityId: req.params.id,
      summary: `Updated template "${before.name}"`,
      before,
      after: patch,
    });
    res.json({ row: after });
  }),
);

/* ================================================================== */
/* Drip campaigns                                                     */
/* ================================================================== */

const campaignStepSchema = z.object({
  dayOffset: z.number().int().min(0).max(3650),
  templateId: z.string().min(1),
  channel: z.string().trim().min(1).max(40),
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
  channel: z.string().trim().min(1).max(40).default('text'),
  steps: z.array(campaignStepSchema).min(1, 'A campaign needs at least one step.'),
});

commsRouter.get(
  '/campaigns',
  ah(async (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM drip_campaigns ORDER BY name').all() as any[];
    res.json({ rows: rows.map(shapeCampaign) });
  }),
);

commsRouter.post(
  '/campaigns',
  requirePermission('template.manage'),
  ah(async (req, res) => {
    const input = parseBody(campaignSchema, req.body ?? {});
    const actor = currentUser(req);
    const errors = stepTemplateErrors(input.steps);
    if (errors.length) {
      throw validationError('Some campaign steps need attention.', errors);
    }
    const id = newId('camp');
    const at = now();
    getDb()
      .prepare(
        `INSERT INTO drip_campaigns
          (id, name, description, channel, steps, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, input.name, input.description, input.channel, JSON.stringify(input.steps), actor.id, at, at);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: id,
      summary: `Created campaign "${input.name}"`,
      after: input,
    });
    res.status(201).json({ row: shapeCampaign(getDb().prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(id)) });
  }),
);

const campaignPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  channel: z.string().trim().min(1).max(40).optional(),
  active: z.boolean().optional(),
  steps: z.array(campaignStepSchema).min(1).optional(),
});

commsRouter.patch(
  '/campaigns/:id',
  requirePermission('template.manage'),
  ah(async (req, res) => {
    const input = parseBody(campaignPatchSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(req.params.id) as any,
      'Campaign',
    );
    if (input.steps) {
      const errors = stepTemplateErrors(input.steps);
      if (errors.length) throw validationError('Some campaign steps need attention.', errors);
    }

    const patch: any = {
      name: input.name ?? before.name,
      description: input.description ?? before.description,
      channel: input.channel ?? before.channel,
      // active drives pause/resume of the whole campaign.
      active: input.active === undefined ? before.active : input.active ? 1 : 0,
      steps: input.steps === undefined ? before.steps : JSON.stringify(input.steps),
    };
    db.prepare(
      `UPDATE drip_campaigns SET
         name = @name, description = @description, channel = @channel,
         active = @active, steps = @steps, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, updated_at: now(), id: req.params.id });

    const after = db.prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'campaign.updated',
      entityType: 'campaign',
      entityId: req.params.id,
      summary: `Updated campaign "${before.name}"`,
      before,
      after: patch,
    });
    res.json({ row: shapeCampaign(after) });
  }),
);

const enrollSchema = z.object({ prospectId: z.string().min(1) });

commsRouter.post(
  '/campaigns/:id/enroll',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const input = parseBody(enrollSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const campaign = must(
      db.prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(req.params.id) as any,
      'Campaign',
    );
    const prospect = must(
      db.prepare('SELECT * FROM prospects WHERE id = ?').get(input.prospectId) as any,
      'Prospect',
    );
    if (prospect.archived_at) {
      throw validationError('That prospect is no longer active.', [
        { path: 'prospectId', message: 'Prospect is archived.' },
      ]);
    }
    const contact = must(
      db.prepare('SELECT * FROM contacts WHERE id = ?').get(prospect.contact_id) as any,
      'Contact',
    );
    assertConsent(campaign.channel, contact);

    const dupe = db
      .prepare('SELECT id FROM drip_enrollments WHERE campaign_id = ? AND prospect_id = ?')
      .get(campaign.id, prospect.id);
    if (dupe) {
      throw conflict('This prospect is already enrolled in that campaign.');
    }

    const steps = parseSteps(campaign.steps);
    const dayOffset = steps[0]?.dayOffset ?? 0;
    const at = now();
    const id = newId('enr');
    db.prepare(
      `INSERT INTO drip_enrollments
        (id, campaign_id, prospect_id, contact_id, status, current_step, next_at,
         started_at, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
    ).run(id, campaign.id, prospect.id, contact.id, at + dayOffset * DAY_MS, at, actor.id, at);

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'campaign.enrolled',
      entityType: 'enrollment',
      entityId: id,
      summary: `Enrolled ${contactName(contact)} in campaign "${campaign.name}"`,
      after: { campaignId: campaign.id, prospectId: prospect.id, status: 'active', next_at: at + dayOffset * DAY_MS },
    });
    res.status(201).json({ row: db.prepare('SELECT * FROM drip_enrollments WHERE id = ?').get(id) });
  }),
);

const enrollmentPatchSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'unsubscribed']),
});

commsRouter.patch(
  '/enrollments/:id',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const input = parseBody(enrollmentPatchSchema, req.body ?? {});
    const actor = currentUser(req);
    const db = getDb();
    const before = must(
      db.prepare('SELECT * FROM drip_enrollments WHERE id = ?').get(req.params.id) as any,
      'Enrollment',
    );
    const at = now();
    // ended_at marks a terminal state; it is cleared if the enrollment resumes.
    const endedAt =
      input.status === 'completed' || input.status === 'unsubscribed' ? at : null;
    db.prepare('UPDATE drip_enrollments SET status = ?, ended_at = ? WHERE id = ?').run(
      input.status,
      endedAt,
      req.params.id,
    );

    const after = db.prepare('SELECT * FROM drip_enrollments WHERE id = ?').get(req.params.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'enrollment.updated',
      entityType: 'enrollment',
      entityId: req.params.id,
      summary: `Enrollment set to ${input.status}`,
      before: { status: before.status, ended_at: before.ended_at },
      after: { status: input.status, ended_at: endedAt },
    });
    res.json({ row: after });
  }),
);

commsRouter.post(
  '/enrollments/:id/send-next',
  requirePermission('comms.log'),
  ah(async (req, res) => {
    const actor = currentUser(req);
    const db = getDb();
    const enrollment = must(
      db.prepare('SELECT * FROM drip_enrollments WHERE id = ?').get(req.params.id) as any,
      'Enrollment',
    );
    if (enrollment.status !== 'active') {
      throw conflict(`This enrollment is ${enrollment.status} — only active enrollments can send.`);
    }
    const campaign = must(
      db.prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(enrollment.campaign_id) as any,
      'Campaign',
    );
    const steps = parseSteps(campaign.steps);
    const stepIndex = enrollment.current_step;
    if (stepIndex >= steps.length) {
      throw conflict('Every step of this campaign has already been sent.');
    }
    const step = steps[stepIndex];
    const template = must(
      db.prepare('SELECT * FROM communication_templates WHERE id = ?').get(step.templateId) as any,
      'Communication template',
    );
    const contact = must(
      db.prepare('SELECT * FROM contacts WHERE id = ?').get(enrollment.contact_id) as any,
      'Contact',
    );
    assertConsent(step.channel, contact);

    const vars = templateVars(contact, actor.name);
    const delivery = resolveDelivery(step.channel);
    const status = outboundStatus(step.channel, delivery);
    const notice = deliveryNotice(status, delivery);
    const at = now();

    const commId = newId('cm');
    db.prepare(
      `INSERT INTO communications
        (id, channel, direction, status, subject, body, outcome, provider, test_mode,
         consent_ok, contact_id, company_id, prospect_id, template_id, campaign_id,
         logged_by, occurred_at, created_at)
       VALUES (?, ?, 'outbound', ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commId,
      step.channel,
      status,
      renderTemplate(template.subject ?? '', vars),
      renderTemplate(template.body ?? '', vars),
      delivery.provider,
      delivery.testMode ? 1 : 0,
      contact.id,
      contact.company_id ?? null,
      enrollment.prospect_id,
      template.id,
      campaign.id,
      actor.id,
      at,
      at,
    );

    // Test mode records 'draft' on the event too — never 'delivered'.
    const eventId = newId('drp');
    db.prepare(
      `INSERT INTO drip_events
        (id, enrollment_id, step, channel, status, communication_id, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(eventId, enrollment.id, stepIndex, step.channel, status, commId, notice, at);

    const nextStep = steps[stepIndex + 1];
    const patch = {
      current_step: stepIndex + 1,
      next_at: nextStep ? at + nextStep.dayOffset * DAY_MS : null,
      status: nextStep ? enrollment.status : 'completed',
      ended_at: nextStep ? enrollment.ended_at : at,
    };
    db.prepare(
      `UPDATE drip_enrollments SET current_step = ?, next_at = ?, status = ?, ended_at = ?
        WHERE id = ?`,
    ).run(patch.current_step, patch.next_at, patch.status, patch.ended_at, enrollment.id);

    const updated = db.prepare('SELECT * FROM drip_enrollments WHERE id = ?').get(enrollment.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'enrollment.step_sent',
      entityType: 'enrollment',
      entityId: enrollment.id,
      summary: `Step ${stepIndex + 1} of "${campaign.name}" recorded as ${status} for ${contactName(contact)}`,
      before: { current_step: enrollment.current_step, status: enrollment.status, next_at: enrollment.next_at },
      after: patch,
      meta: { step: stepIndex, channel: step.channel, status, testMode: delivery.testMode },
    });

    res.status(201).json({
      communication: db.prepare('SELECT * FROM communications WHERE id = ?').get(commId),
      event: db.prepare('SELECT * FROM drip_events WHERE id = ?').get(eventId),
      enrollment: updated,
      delivery: {
        provider: delivery.provider,
        testMode: delivery.testMode,
        status,
        notice,
      },
    });
  }),
);

commsRouter.get(
  '/campaigns/:id/activity',
  ah(async (req, res) => {
    const db = getDb();
    const campaign = must(
      db.prepare('SELECT * FROM drip_campaigns WHERE id = ?').get(req.params.id) as any,
      'Campaign',
    );
    const enrollments = db
      .prepare(
        `SELECT e.*, co.first_name, co.last_name, co.email, co.phone, co.mobile,
                p.stage AS prospect_stage, cmp.name AS company_name
           FROM drip_enrollments e
           JOIN contacts co ON co.id = e.contact_id
           JOIN prospects p ON p.id = e.prospect_id
           LEFT JOIN companies cmp ON cmp.id = co.company_id
          WHERE e.campaign_id = ?
          ORDER BY e.started_at DESC`,
      )
      .all(campaign.id);
    const events = db
      .prepare(
        `SELECT de.* FROM drip_events de
           JOIN drip_enrollments e ON e.id = de.enrollment_id
          WHERE e.campaign_id = ?
          ORDER BY de.at DESC
          LIMIT 100`,
      )
      .all(campaign.id);
    res.json({ campaign: shapeCampaign(campaign), enrollments, events });
  }),
);
