import { getDb, now } from './database.js';
import { newId } from '../core/ids.js';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '../core/permissions.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const LEAD_SOURCES: Array<[string, string]> = [
  ['referral', 'Referral'],
  ['gc_outreach', 'GC / Contractor Outreach'],
  ['website', 'Website'],
  ['drive_by', 'Drive-By / Sign'],
  ['existing_customer', 'Existing Customer'],
  ['partner', 'Partner'],
  ['other', 'Other'],
];

const TERRITORIES: Array<[string, string]> = [
  ['metro', 'Metro Core'],
  ['north', 'North County'],
  ['south', 'South County'],
  ['east', 'East Valley'],
  ['west', 'West Side'],
];

const TIMING_BUCKETS: Array<[string, string, number]> = [
  ['within_2w', 'Within 2 Weeks', 14],
  ['within_month', 'Within a Month', 30],
  ['follow_month', 'Follow Up in a Month', 30],
  ['custom', 'Custom Date', 0],
];

const PROSPECT_DISPOSITIONS = [
  ['new', 'New / Untouched'],
  ['in_discovery', 'In Discovery'],
  ['general_followup', 'General Follow-up'],
  ['waiting_blueprints', 'Waiting on Blueprints'],
  ['waiting_permit', 'Waiting on Permit'],
];

const BID_DISPOSITIONS = [
  ['site_visit_needed', 'Site Visit Needed'],
  ['waiting_info', 'Waiting on Info'],
  ['waiting_sub_quote', 'Waiting on Sub Quote'],
  ['in_pricing', 'In Pricing'],
  ['ready_for_quote', 'Ready for Quote'],
];

/** key, name, taxable — tax is applied to the taxable cost buckets only. */
const COST_CATEGORIES = [
  ['labor', 'Labor', 0],
  ['materials', 'Materials', 1],
  ['hardware', 'Hardware', 0],
  ['equipment', 'Crane & Equipment', 0],
  ['dump', 'Dump & Disposal', 0],
  ['subcontractor', 'Subcontractors', 0],
  ['other', 'Other', 0],
];

const DEFAULT_SETTINGS: Record<string, unknown> = {
  // Margin floor: a released quote below this needs an approved exception.
  margin_floor: { default: 15, by_trade: {} },
  // Commission is a percentage of the SELLING price, deducted after gross profit.
  commission: { default_pct: 10 },
  // Tax applies to taxable cost buckets (materials by default).
  tax: { default_rate: 8.5 },
  // Benchmarks flag estimates outside the normal range for review.
  benchmarks: { enabled: true },
  // A job cannot advance to complete while these remain unresolved.
  production: {
    require_daily_report_to_complete: true,
    require_no_open_blockers_to_complete: true,
    require_paid_balance_to_close: true,
  },
  communications: {
    // Until a provider is configured the app records drafts, never "sent".
    force_test_mode: true,
    provider: 'none',
    second_attempt_hours: 4,
    no_answer_callback_hours: 3,
  },
  demo_data: false,
};

const WON_GATES: Array<[string, number, number, number, number, number]> = [
  // project_type, contract, deposit, insurance, compliance, approval
  ['standard', 1, 1, 1, 1, 1],
  ['warranty_repair', 1, 0, 1, 0, 1],
  ['emergency', 1, 0, 0, 0, 1],
];

interface ScopeQuestion {
  id: string;
  label: string;
  type: 'select' | 'number' | 'text' | 'textarea' | 'yesno';
  options?: string[];
  unit?: string;
  required: boolean;
  help?: string;
}

const SCOPE_TEMPLATES: Array<{
  trade: string;
  name: string;
  questions: ScopeQuestion[];
}> = [
  {
    trade: 'roofing',
    name: 'Roofing scope intake',
    questions: [
      {
        id: 'system_type',
        label: 'Roofing assembly / system type',
        type: 'select',
        required: true,
        options: [
          'Asphalt shingle',
          'Clay or concrete tile',
          'Spray polyurethane foam',
          'Metal panel',
          'Standing seam',
          'Modified bitumen',
          'Single-ply (TPO / EPDM)',
        ],
      },
      {
        id: 'core_req',
        label: 'Core requirement',
        type: 'select',
        required: true,
        options: [
          'Full tear-off and replacement',
          'Recover over existing',
          'Partial dry-out and repair',
          'New construction',
        ],
        help: 'Drives tear-off labour, dumpster volume and deck repair assumptions.',
      },
      {
        id: 'scuppers',
        label: 'Scuppers',
        type: 'select',
        required: true,
        options: ['Existing and adequate', 'New scuppers required', 'None on this roof'],
      },
      {
        id: 'scupper_qty',
        label: 'Scuppers required (count)',
        type: 'number',
        unit: 'ea',
        required: false,
      },
      {
        id: 'warranty',
        label: 'Warranty requirement',
        type: 'select',
        required: true,
        options: ['None', 'Manufacturer standard', '10-year', '20-year', '25-year or NDL'],
      },
      {
        id: 'squares',
        label: 'Roof area',
        type: 'number',
        unit: 'sq',
        required: true,
        help: 'Roofing squares from the takeoff or the plans.',
      },
      {
        id: 'pitch',
        label: 'Predominant pitch (rise per 12)',
        type: 'number',
        unit: '/12',
        required: false,
      },
      {
        id: 'tearoff_existing',
        label: 'Existing roof to be torn off?',
        type: 'yesno',
        required: true,
      },
      {
        id: 'deck_repairs',
        label: 'Plywood / deck repair allowance expected?',
        type: 'yesno',
        required: true,
      },
      {
        id: 'owner_furnished',
        label: 'Owner-furnished material or equipment on site?',
        type: 'yesno',
        required: false,
      },
      {
        id: 'access_notes',
        label: 'Access, staging and hoisting notes',
        type: 'textarea',
        required: false,
      },
    ],
  },
  {
    trade: 'framing',
    name: 'Framing scope intake',
    questions: [
      {
        id: 'sqft',
        label: 'Square footage',
        type: 'number',
        unit: 'sqft',
        required: true,
      },
      {
        id: 'supply_resp',
        label: 'Lumber and truss supply responsibility',
        type: 'select',
        required: true,
        options: [
          'We supply material',
          'Owner supplies material',
          'GC supplies material',
          'Trusses by others, we set',
        ],
      },
      {
        id: 'hardware',
        label: 'Hardware package',
        type: 'select',
        required: true,
        options: [
          'Standard hangers and fasteners',
          'Hurricane / high-wind connectors',
          'Engineered hardware by others',
          'Owner supplied',
        ],
      },
      {
        id: 'crane',
        label: 'Crane required?',
        type: 'yesno',
        required: true,
      },
      {
        id: 'crane_days',
        label: 'Crane days expected',
        type: 'number',
        unit: 'days',
        required: false,
      },
      {
        id: 'crew_size',
        label: 'Planned crew size',
        type: 'number',
        unit: 'people',
        required: true,
      },
      {
        id: 'work_days',
        label: 'Planned work days',
        type: 'number',
        unit: 'days',
        required: true,
      },
      {
        id: 'demo_scope',
        label: 'Existing structure to demo first?',
        type: 'yesno',
        required: true,
      },
      {
        id: 'assumptions',
        label: 'Labour and material assumptions',
        type: 'textarea',
        required: false,
      },
    ],
  },
  {
    trade: 'demolition',
    name: 'Demolition scope intake',
    questions: [
      {
        id: 'hazmat',
        label: 'Hazardous materials',
        type: 'select',
        required: true,
        options: [
          'None suspected',
          'Yes — licensed abatement required',
          'Unknown — testing required',
        ],
      },
      {
        id: 'utility_disconnect',
        label: 'Utility disconnection',
        type: 'select',
        required: true,
        options: [
          'Already disconnected',
          'We coordinate',
          'GC / owner coordinates',
        ],
      },
      {
        id: 'salvage',
        label: 'Salvage requirements',
        type: 'select',
        required: true,
        options: ['None', 'Yes — material to be separated', 'Yes — owner to salvage on site'],
      },
      {
        id: 'disposal',
        label: 'Dumpster / dump-pull requirements',
        type: 'select',
        required: true,
        options: [
          'Dumpster on site',
          'Dump pulls by our truck',
          'Owner hauls',
          'Load and haul by others',
        ],
      },
      {
        id: 'dumpster_count',
        label: 'Dumpsters expected',
        type: 'number',
        unit: 'ea',
        required: false,
      },
      {
        id: 'structure',
        label: 'Structure and access notes',
        type: 'textarea',
        required: false,
      },
    ],
  },
];

const COMM_TEMPLATES: Array<{
  key: string;
  name: string;
  channel: string;
  category: string;
  subject?: string;
  body: string;
}> = [
  {
    key: 'no_answer_first',
    name: 'No-Answer Text (first attempt)',
    channel: 'text',
    category: 'prospecting',
    body:
      "Hey {contact.first_name}, it's {sender.first_name}. Just tried calling you. Give me a call back at your earliest convenience.",
  },
  {
    key: 'no_answer_second',
    name: 'No-Answer Text (second attempt)',
    channel: 'text',
    category: 'prospecting',
    body:
      "Hey {contact.first_name}, it's {sender.first_name} again — following up on my last message. Happy to work around your schedule, just let me know a good time.",
  },
  {
    key: 'drip_no_active_projects',
    name: 'General Follow-up, No Active Projects',
    channel: 'text',
    category: 'campaign',
    body:
      "Hey {contact.first_name}, it's {sender.first_name}, just following up from our last conversation. I know you mentioned you don't have anything active right now. Let me know if I can help in any capacity. Looking forward to hearing from you.",
  },
  {
    key: 'credibility_package',
    name: 'Credibility Package',
    channel: 'email',
    category: 'sales',
    subject: 'Our work and references',
    body:
      "Hi {contact.first_name},\n\nSharing a few completed projects and references so you can see how we work:\n\n- Project photos: {link.photos}\n- Reference list: {link.references}\n- Our website: {link.website}\n\nHappy to walk any of these with you.\n\n{sender.name}",
  },
  {
    key: 'referral_list',
    name: 'Referral List Request',
    channel: 'email',
    category: 'sales',
    subject: 'References for your project',
    body: 'Hi {contact.first_name},\n\nHere are owners of similar projects you can speak with directly:\n\n{link.references}\n\n{sender.name}',
  },
  {
    key: 'appointment_confirm',
    name: 'Appointment Confirmation',
    channel: 'text',
    category: 'prospecting',
    body:
      'Hi {contact.first_name}, confirming our appointment on {appointment.when} at {appointment.where}. Reply STOP to opt out.',
  },
  {
    key: 'blueprint_request',
    name: 'Request for Blueprints',
    channel: 'email',
    category: 'prospecting',
    subject: 'Plans needed to prepare your estimate',
    body:
      "Hi {contact.first_name},\n\nTo price this accurately I need the current plan set. Could you send the latest revision, or let me know who to request it from?\n\n{scope.summary}\n\n{sender.name}",
  },
  {
    key: 'permit_followup',
    name: 'Permit Status Follow-up',
    channel: 'text',
    category: 'prospecting',
    body:
      'Hi {contact.first_name}, any word on the permit? Once it clears I can get your quote moving. {sender.name}',
  },
  {
    key: 'proposal_followup',
    name: 'Proposal Follow-up',
    channel: 'email',
    category: 'sales',
    subject: 'Following up on your proposal',
    body:
      "Hi {contact.first_name},\n\nFollowing up on the proposal we sent for {project.name}. Happy to walk through the scope, options or pricing — anything you'd like adjusted.\n\n{sender.name}",
  },
  {
    key: 'contract_reminder',
    name: 'Contract Reminder',
    channel: 'email',
    category: 'sales',
    subject: 'Your contract is ready to sign',
    body:
      "Hi {contact.first_name},\n\nYour contract for {project.name} is ready for signature. Once it's signed and the deposit is received we can get you on the schedule.\n\n{sender.name}",
  },
  {
    key: 'deposit_reminder',
    name: 'Deposit Reminder',
    channel: 'email',
    category: 'sales',
    subject: 'Deposit to reserve your schedule slot',
    body:
      "Hi {contact.first_name},\n\nA deposit of {deposit.amount} reserves your slot on the schedule for {project.name}.\n\n{sender.name}",
  },
];

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

/**
 * Roles and permissions are defined in code (`server/core/permissions.ts`)
 * so the authorization check and the stored rows can never disagree; this
 * mirrors them into tables so the admin UI and reporting have rows to read.
 */
function seedRolesAndPermissions(db: ReturnType<typeof getDb>): void {
  const insPerm = db.prepare(
    'INSERT OR IGNORE INTO permissions (key, name, description) VALUES (?, ?, ?)',
  );
  for (const [key, name] of Object.entries(PERMISSIONS)) insPerm.run(key, name, '');

  for (const [key, meta] of Object.entries(ROLES)) {
    db.prepare(
      `INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description`,
    ).run(key, meta.name, meta.description);
  }

  const delRolePerm = db.prepare('DELETE FROM role_permissions WHERE role_key = ?');
  const insRolePerm = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES (?, ?)',
  );
  for (const [roleKey, list] of Object.entries(ROLE_PERMISSIONS)) {
    delRolePerm.run(roleKey);
    for (const p of list) insRolePerm.run(roleKey, p);
  }
}

/** Insert keyed config rows without ever duplicating them. */
function seedKeyed(
  db: ReturnType<typeof getDb>,
  table: string,
  rows: Array<[string, string]>,
): void {
  const nowTs = now();
  const stmt = db.prepare(
    `INSERT INTO ${table} (id, key, name, sort, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );
  for (const [key, name] of rows) stmt.run(newId(table.slice(0, 3)), key, name, nowTs, nowTs);
}

function seedDispositions(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  const run = (workspace: string, rows: string[][]) => {
    rows.forEach(([key, name], i) => {
      db.prepare(
        `INSERT INTO dispositions (id, workspace, key, name, is_system, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(workspace, key) DO UPDATE SET name = excluded.name, sort = excluded.sort, updated_at = excluded.updated_at`,
      ).run(newId('dsp'), workspace, key, name, i, nowTs, nowTs);
    });
  };
  run('prospect', PROSPECT_DISPOSITIONS);
  run('bid', BID_DISPOSITIONS);
}

function seedCostCategories(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  COST_CATEGORIES.forEach(([key, name, taxable], i) => {
    db.prepare(
      `INSERT INTO cost_categories (id, key, name, taxable, is_system, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, taxable = excluded.taxable, sort = excluded.sort, updated_at = excluded.updated_at`,
    ).run(newId('cat'), key, name, taxable, i, nowTs, nowTs);
  });
}

function seedSettings(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, JSON.stringify(value), nowTs);
  }
}

function seedGates(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  for (const [type, contract, deposit, insurance, compliance, approval] of WON_GATES) {
    db.prepare(
      `INSERT INTO won_gate_configs
         (id, project_type, require_contract_signed, require_deposit, require_insurance,
          require_compliance, require_approval, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_type) DO NOTHING`,
    ).run(newId('gate'), type, contract, deposit, insurance, compliance, approval, nowTs);
  }
}

function seedScopeTemplates(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  for (const t of SCOPE_TEMPLATES) {
    const existing = db
      .prepare('SELECT id FROM scope_templates WHERE trade = ? AND is_system = 1')
      .get(t.trade);
    if (existing) {
      db.prepare(
        'UPDATE scope_templates SET questions = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(t.questions), nowTs, (existing as any).id);
      continue;
    }
    db.prepare(
      `INSERT INTO scope_templates (id, trade, name, version, questions, is_system, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?)`,
    ).run(newId('sct'), t.trade, t.name, JSON.stringify(t.questions), nowTs, nowTs);
  }
}

function seedCommsTemplates(db: ReturnType<typeof getDb>): void {
  const nowTs = now();
  for (const t of COMM_TEMPLATES) {
    db.prepare(
      `INSERT INTO communication_templates (id, key, name, channel, category, subject, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, channel = excluded.channel, category = excluded.category,
         subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
    ).run(
      newId('ctp'),
      t.key,
      t.name,
      t.channel,
      t.category,
      t.subject ?? '',
      t.body,
      nowTs,
      nowTs,
    );
  }
}

/**
 * Retires the legacy seeded demo sign-ins (`*@quest.test`).
 *
 * The demo team was dropped when self-serve sign-up was introduced, but
 * databases created before that change still hold those accounts — including
 * the privileged `owner@quest.test` login. Runs on every boot, so the demo
 * credentials can never come back, locally or in Firestore.
 *
 * They are neutralised rather than deleted because history references them:
 * `audit_events.actor_id`, `bids.created_by`, `tasks.assignee_id` and ~30
 * other columns hold user ids with NO ACTION, so a hard delete would fail (or
 * erase the audit trail). The account is deactivated, de-identified and its
 * password discarded — it can never authenticate again and never appears in
 * the active roster.
 */
export function purgeDemoAccounts(): number {
  const db = getDb();
  const demo = db
    .prepare(`SELECT id FROM users WHERE email LIKE '%@quest.test'`)
    .all() as Array<{ id: string }>;
  if (!demo.length) return 0;
  const retire = db.prepare(
    `UPDATE users SET email = ?, name = 'Removed demo account', password_hash = '', active = 0, updated_at = ? WHERE id = ?`,
  );
  const nowTs = now();
  for (const u of demo) retire.run(`removed+${u.id}@quest.invalid`, nowTs, u.id);
  return demo.length;
}

export function seedConfiguration(): void {
  const db = getDb();
  const run = db.transaction(() => {
    seedRolesAndPermissions(db);
    seedKeyed(db, 'lead_sources', LEAD_SOURCES);
    seedKeyed(db, 'territories', TERRITORIES);
    const nowTs = now();
    for (const [key, name, days] of TIMING_BUCKETS) {
      db.prepare(
        `INSERT INTO timing_buckets (id, key, name, days, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, days = excluded.days, updated_at = excluded.updated_at`,
      ).run(newId('tmg'), key, name, days, nowTs, nowTs);
    }
    seedDispositions(db);
    seedCostCategories(db);
    seedSettings(db);
    seedGates(db);
    seedScopeTemplates(db);
    seedCommsTemplates(db);
  });
  run();
}
