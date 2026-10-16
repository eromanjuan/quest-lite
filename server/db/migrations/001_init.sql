-- =====================================================================
-- Quest Lite — Initial schema
-- Dialect: SQLite. All ids are app-generated TEXT. Timestamps are INTEGER
-- epoch milliseconds (UTC). Booleans are INTEGER 0/1. JSON is stored as TEXT.
--
-- Design rules:
--   * Every business entity carries created_at/updated_at and, where the
--     record can be retired, archived_at (soft delete — history is kept).
--   * Deleting a configuration row that historical rows point at is
--     prevented; configuration is deactivated instead (active = 0).
--   * Money values are REAL but always produced by server-side rounding
--     helpers (round2) and re-validated on every write.
-- =====================================================================

-- ---------- Identity, roles, permissions ----------

CREATE TABLE roles (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_key   TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission)
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_key      TEXT NOT NULL REFERENCES roles(key),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,            -- sha256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------- Audit ----------

CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  request_id  TEXT,
  actor_id    TEXT REFERENCES users(id),
  actor_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  before      TEXT,
  after       TEXT,
  meta        TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, at);
CREATE INDEX idx_audit_actor  ON audit_events(actor_id, at);
CREATE INDEX idx_audit_at     ON audit_events(at);

-- ---------- Configuration ----------

CREATE TABLE lead_sources (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_lead_sources_key ON lead_sources(key);

CREATE TABLE territories (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_territories_key ON territories(key);

CREATE TABLE timing_buckets (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_timing_key ON timing_buckets(key);

CREATE TABLE dispositions (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,               -- 'prospect' | 'bid'
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  is_system  INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dispositions_key ON dispositions(workspace, key);

CREATE TABLE cost_categories (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  taxable    INTEGER NOT NULL DEFAULT 0,   -- applies to SELL price, not cost
  active     INTEGER NOT NULL DEFAULT 1,
  is_system  INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_cost_cat_key ON cost_categories(key);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                -- JSON
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE benchmarks (
  id           TEXT PRIMARY KEY,
  trade        TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'standard',
  label        TEXT NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'sqft',
  min_value    REAL,
  target_value REAL,
  max_value    REAL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ---------- Core CRM ----------

CREATE TABLE companies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'customer', -- customer|gc|vendor|subcontractor|other
  territory_id TEXT REFERENCES territories(id),
  website      TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT NOT NULL DEFAULT '',
  created_by   TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER
);
CREATE INDEX idx_companies_name ON companies(name);
CREATE INDEX idx_companies_kind ON companies(kind);

CREATE TABLE contacts (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT REFERENCES companies(id),
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  email              TEXT,
  phone              TEXT,
  mobile             TEXT,
  is_decision_maker  INTEGER NOT NULL DEFAULT 0,
  contact_pref       TEXT NOT NULL DEFAULT 'phone', -- phone|text|email
  consent_sms        INTEGER NOT NULL DEFAULT 0,
  consent_email      INTEGER NOT NULL DEFAULT 1,
  opt_out_at         INTEGER,
  notes              TEXT NOT NULL DEFAULT '',
  created_by         TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  archived_at        INTEGER
);
CREATE INDEX idx_contacts_name    ON contacts(last_name, first_name);
CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_contacts_phone   ON contacts(phone);

-- ---------- Prospecting ----------

CREATE TABLE prospects (
  id                TEXT PRIMARY KEY,
  contact_id        TEXT NOT NULL REFERENCES contacts(id),
  company_id        TEXT REFERENCES companies(id),
  owner_id          TEXT REFERENCES users(id),
  stage             TEXT NOT NULL DEFAULT 'prospect',  -- prospect|lead|nurturing
  disposition_id    TEXT REFERENCES dispositions(id),
  temperature       TEXT NOT NULL DEFAULT 'warm',      -- hot|warm|cold
  timing            TEXT NOT NULL DEFAULT 'within_month',
  timing_date       INTEGER,
  source_id         TEXT REFERENCES lead_sources(id),
  territory_id      TEXT REFERENCES territories(id),
  scope_summary     TEXT NOT NULL DEFAULT '',
  project_address   TEXT NOT NULL DEFAULT '',
  last_contact_at   INTEGER,
  next_followup_at  INTEGER,
  handoff_at        INTEGER,
  handoff_bid_id    TEXT,
  created_by        TEXT REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);
CREATE INDEX idx_prospects_stage  ON prospects(stage, archived_at);
CREATE INDEX idx_prospects_owner  ON prospects(owner_id);
CREATE INDEX idx_prospects_follow ON prospects(next_followup_at);
CREATE INDEX idx_prospects_contact ON prospects(contact_id);

-- The cross-workspace thread: one opportunity travels from Prospecting
-- through Underwriting and Sales into Production.
CREATE TABLE opportunities (
  id              TEXT PRIMARY KEY,
  prospect_id     TEXT REFERENCES prospects(id),
  contact_id      TEXT NOT NULL REFERENCES contacts(id),
  company_id      TEXT REFERENCES companies(id),
  name            TEXT NOT NULL,
  trade           TEXT NOT NULL DEFAULT '',
  scope_summary   TEXT NOT NULL DEFAULT '',
  project_address TEXT NOT NULL DEFAULT '',
  estimated_value REAL,
  stage           TEXT NOT NULL DEFAULT 'prospect',
                  -- prospect|underwriting|sales|production|won|lost|dead
  source_id       TEXT REFERENCES lead_sources(id),
  territory_id    TEXT REFERENCES territories(id),
  owner_id        TEXT REFERENCES users(id),
  created_by      TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE INDEX idx_opp_contact ON opportunities(contact_id);
CREATE INDEX idx_opp_stage   ON opportunities(stage);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'follow_up',
                 -- follow_up|call|text|email|site_visit|document|task
  assignee_id    TEXT NOT NULL REFERENCES users(id),
  due_at         INTEGER NOT NULL,
  reminder_at    INTEGER,
  status         TEXT NOT NULL DEFAULT 'open',  -- open|done|cancelled
  priority       INTEGER NOT NULL DEFAULT 0,    -- 0 normal, 1 high
  contact_id     TEXT REFERENCES contacts(id),
  prospect_id    TEXT REFERENCES prospects(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  bid_id         TEXT,
  deal_id        TEXT,
  project_id     TEXT,
  job_id         TEXT,
  completed_at   INTEGER,
  completed_by   TEXT REFERENCES users(id),
  completion_note TEXT NOT NULL DEFAULT '',
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status, due_at);
CREATE INDEX idx_tasks_due      ON tasks(status, due_at);
CREATE INDEX idx_tasks_contact  ON tasks(contact_id);
CREATE INDEX idx_tasks_prospect ON tasks(prospect_id);

CREATE TABLE communication_templates (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  channel    TEXT NOT NULL,                -- text|email|call_script
  category   TEXT NOT NULL DEFAULT 'general',
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_commtmpl_key ON communication_templates(key);

CREATE TABLE communications (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,              -- call|text|email|note|meeting
  direction    TEXT NOT NULL DEFAULT 'outbound', -- outbound|inbound|internal
  status       TEXT NOT NULL DEFAULT 'logged',
               -- draft|queued|sent|delivered|failed|logged
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  outcome      TEXT,                       -- connected|no_answer|voicemail|...
  provider     TEXT NOT NULL DEFAULT 'none',
  provider_ref TEXT,
  test_mode    INTEGER NOT NULL DEFAULT 1,
  consent_ok   INTEGER NOT NULL DEFAULT 1,
  duration_sec INTEGER,
  contact_id   TEXT REFERENCES contacts(id),
  company_id   TEXT REFERENCES companies(id),
  prospect_id  TEXT REFERENCES prospects(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  bid_id       TEXT,
  deal_id      TEXT,
  project_id   TEXT,
  job_id       TEXT,
  template_id  TEXT REFERENCES communication_templates(id),
  campaign_id  TEXT,
  logged_by    TEXT REFERENCES users(id),
  occurred_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_comm_contact  ON communications(contact_id, occurred_at);
CREATE INDEX idx_comm_prospect ON communications(prospect_id, occurred_at);
CREATE INDEX idx_comm_call     ON communications(channel, occurred_at);
CREATE INDEX idx_comm_campaign ON communications(campaign_id, occurred_at);

CREATE TABLE drip_campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT 'text',
  steps       TEXT NOT NULL DEFAULT '[]',   -- JSON [{dayOffset,templateId,channel}]
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE drip_enrollments (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES drip_campaigns(id) ON DELETE CASCADE,
  prospect_id  TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES contacts(id),
  status       TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|unsubscribed
  current_step INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  created_by   TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  UNIQUE (campaign_id, prospect_id)
);
CREATE INDEX idx_enroll_due ON drip_enrollments(status, next_at);

CREATE TABLE drip_events (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL REFERENCES drip_enrollments(id) ON DELETE CASCADE,
  step            INTEGER NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL,
  communication_id TEXT REFERENCES communications(id),
  detail          TEXT NOT NULL DEFAULT '',
  at              INTEGER NOT NULL
);

-- ---------- Documents ----------

CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL,               -- contact|bid|project|job|deal|company|estimate
  owner_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'attachment',
              -- attachment|blueprint|contract|insurance|compliance|photo|invoice
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  parent_id   TEXT REFERENCES documents(id),
  uploaded_by TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_docs_owner ON documents(owner_type, owner_id, created_at);

-- ---------- Vendors & price book ----------

CREATE TABLE vendors (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'vendor', -- vendor|subcontractor
  phone      TEXT, email TEXT, address TEXT,
  notes      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_vendors_name ON vendors(name);

CREATE TABLE price_book_items (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  vendor_id     TEXT REFERENCES vendors(id),
  unit          TEXT NOT NULL DEFAULT 'EA',
  price         REAL NOT NULL DEFAULT 0,
  tax_class     TEXT NOT NULL DEFAULT 'taxable', -- taxable|exempt
  effective_from INTEGER NOT NULL,
  protected     INTEGER NOT NULL DEFAULT 0,      -- admin-only price edits
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_pb_code ON price_book_items(code);

CREATE TABLE price_book_revisions (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES price_book_items(id) ON DELETE CASCADE,
  price         REAL NOT NULL,
  tax_class     TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  changed_by    TEXT REFERENCES users(id),
  changed_at    INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_pbrev_item ON price_book_revisions(item_id, changed_at);

-- ---------- Underwriting ----------

CREATE TABLE bids (
  id                  TEXT PRIMARY KEY,
  bid_no              TEXT NOT NULL,
  opportunity_id      TEXT REFERENCES opportunities(id),
  prospect_id         TEXT REFERENCES prospects(id),
  contact_id          TEXT NOT NULL REFERENCES contacts(id),
  company_id          TEXT REFERENCES companies(id),
  project_address     TEXT NOT NULL DEFAULT '',
  trade               TEXT NOT NULL,
  scope_summary       TEXT NOT NULL DEFAULT '',
  estimator_id        TEXT REFERENCES users(id),
  stage               TEXT NOT NULL DEFAULT 'scope',  -- scope|takeoff|uw_sheet|quote_built
  disposition_id      TEXT REFERENCES dispositions(id),
  temperature         TEXT NOT NULL DEFAULT 'warm',
  quote_due_at        INTEGER,
  started_at          INTEGER NOT NULL,
  takeoff_required    INTEGER NOT NULL DEFAULT 0,
  perform_mode        TEXT NOT NULL DEFAULT 'self',   -- self|sub|mixed
  current_plan_revision_id TEXT,
  missing_info        TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  released_at         INTEGER,
  released_estimate_id TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  archived_at         INTEGER
);
CREATE UNIQUE INDEX idx_bids_no      ON bids(bid_no);
CREATE INDEX idx_bids_stage          ON bids(stage, archived_at);
CREATE INDEX idx_bids_estimator      ON bids(estimator_id);
CREATE INDEX idx_bids_prospect       ON bids(prospect_id);

CREATE TABLE scope_templates (
  id         TEXT PRIMARY KEY,
  trade      TEXT NOT NULL,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  questions  TEXT NOT NULL,               -- JSON question[]
  active     INTEGER NOT NULL DEFAULT 1,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scopetmpl_trade ON scope_templates(trade, active);

CREATE TABLE scope_responses (
  id          TEXT PRIMARY KEY,
  bid_id      TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES scope_templates(id),
  answers     TEXT NOT NULL DEFAULT '{}',
  missing     TEXT NOT NULL DEFAULT '[]',
  complete    INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (bid_id, template_id)
);

CREATE TABLE plan_revisions (
  id          TEXT PRIMARY KEY,
  bid_id      TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  document_id TEXT REFERENCES documents(id),
  is_current  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (bid_id, revision_no)
);

CREATE TABLE takeoff_items (
  id               TEXT PRIMARY KEY,
  bid_id           TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  code             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  qty              REAL NOT NULL DEFAULT 0,
  unit             TEXT NOT NULL DEFAULT 'EA',
  estimate_line_ref TEXT,
  reviewer_id      TEXT REFERENCES users(id),
  review_status    TEXT NOT NULL DEFAULT 'draft', -- draft|reviewed|disputed
  notes            TEXT NOT NULL DEFAULT '',
  created_by       TEXT REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_takeoff_bid ON takeoff_items(bid_id, plan_revision_id);

CREATE TABLE sub_quotes (
  id           TEXT PRIMARY KEY,
  bid_id       TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  vendor_id    TEXT REFERENCES vendors(id),
  amount       REAL NOT NULL DEFAULT 0,
  quote_date   INTEGER,
  valid_until  INTEGER,
  includes     TEXT NOT NULL DEFAULT '',
  excludes     TEXT NOT NULL DEFAULT '',
  scope_gaps   TEXT NOT NULL DEFAULT '[]',  -- JSON [{gap,responsible,cost}]
  status       TEXT NOT NULL DEFAULT 'requested',
               -- requested|received|accepted|declined|expired
  document_id  TEXT REFERENCES documents(id),
  created_by   TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE estimates (
  id            TEXT PRIMARY KEY,
  bid_id        TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|pending_release|released|superseded
  sheet_kind    TEXT NOT NULL DEFAULT 'generic', -- roofing|crew|generic
  title         TEXT NOT NULL DEFAULT '',
  inputs        TEXT NOT NULL DEFAULT '{}',   -- estimator inputs (source of truth)
  calc          TEXT NOT NULL DEFAULT '{}',   -- server-computed snapshot
  margin_floor  REAL,
  released_at   INTEGER,
  released_by   TEXT REFERENCES users(id),
  parent_id     TEXT REFERENCES estimates(id),
  created_by    TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (bid_id, version)
);
CREATE INDEX idx_estimates_bid ON estimates(bid_id, status);

CREATE TABLE estimate_lines (
  id          TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES cost_categories(id),
  kind        TEXT NOT NULL DEFAULT 'cost',   -- sell|cost
  code        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  qty         REAL NOT NULL DEFAULT 0,
  unit        TEXT NOT NULL DEFAULT 'EA',
  unit_price  REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  taxable     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_estlines_est ON estimate_lines(estimate_id, kind, seq);

CREATE TABLE margin_approvals (
  id               TEXT PRIMARY KEY,
  estimate_id      TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  bid_id           TEXT NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  requested_margin REAL NOT NULL,
  floor_margin     REAL NOT NULL,
  reason           TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  requested_by     TEXT REFERENCES users(id),
  requested_at     INTEGER NOT NULL,
  decided_by       TEXT REFERENCES users(id),
  decided_at       INTEGER,
  decision_note    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_marginappr_est ON margin_approvals(estimate_id, status);
CREATE INDEX idx_marginappr_status ON margin_approvals(status, requested_at);

-- ---------- Sales ----------

CREATE TABLE won_gate_configs (
  id                    TEXT PRIMARY KEY,
  project_type          TEXT NOT NULL,
  require_contract_signed INTEGER NOT NULL DEFAULT 1,
  require_deposit       INTEGER NOT NULL DEFAULT 1,
  require_insurance     INTEGER NOT NULL DEFAULT 1,
  require_compliance    INTEGER NOT NULL DEFAULT 1,
  require_approval      INTEGER NOT NULL DEFAULT 1,
  updated_by            TEXT REFERENCES users(id),
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wongate_type ON won_gate_configs(project_type);

CREATE TABLE deals (
  id                 TEXT PRIMARY KEY,
  deal_no            TEXT NOT NULL,
  opportunity_id     TEXT REFERENCES opportunities(id),
  bid_id             TEXT NOT NULL REFERENCES bids(id),
  contact_id         TEXT NOT NULL REFERENCES contacts(id),
  company_id         TEXT REFERENCES companies(id),
  project_name       TEXT NOT NULL,
  project_address    TEXT NOT NULL DEFAULT '',
  project_type       TEXT NOT NULL DEFAULT 'standard',
  trade              TEXT NOT NULL DEFAULT '',
  value              REAL NOT NULL DEFAULT 0,
  closer_id          TEXT REFERENCES users(id),
  stage              TEXT NOT NULL DEFAULT 'estimate_sent',
                     -- estimate_sent|negotiating|contract_sent|waiting_to_sign|won|lost
  current_proposal_id TEXT,
  expected_close_at  INTEGER,
  last_contact_at    INTEGER,
  next_followup_at   INTEGER,
  lost_reason        TEXT,
  lost_at            INTEGER,
  quote_sent_at      INTEGER,
  won_at             INTEGER,
  handoff_at         INTEGER,
  handoff_project_id TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  archived_at        INTEGER
);
CREATE UNIQUE INDEX idx_deals_no    ON deals(deal_no);
CREATE INDEX idx_deals_stage        ON deals(stage, archived_at);
CREATE INDEX idx_deals_closer       ON deals(closer_id);

CREATE TABLE proposals (
  id                  TEXT PRIMARY KEY,
  deal_id             TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft',
                      -- draft|sent|accepted|declined|superseded
  title               TEXT NOT NULL DEFAULT '',
  pricing_mode        TEXT NOT NULL DEFAULT 'lump',  -- lump|by_trade
  options             TEXT NOT NULL DEFAULT '[]',    -- JSON [{key,label,price,scope}]
  selected_option     TEXT,
  subtotal            REAL NOT NULL DEFAULT 0,
  total               REAL NOT NULL DEFAULT 0,
  payment_terms       TEXT NOT NULL DEFAULT '',
  valid_days          INTEGER NOT NULL DEFAULT 30,
  scope_snapshot      TEXT NOT NULL DEFAULT '{}',
  estimate_snapshot   TEXT NOT NULL DEFAULT '{}',
  attachments         TEXT NOT NULL DEFAULT '[]',
  delivery_method     TEXT,
  recipient_contact_id TEXT REFERENCES contacts(id),
  sent_at             INTEGER,
  responded_at        INTEGER,
  response_note       TEXT NOT NULL DEFAULT '',
  created_by          TEXT REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (deal_id, version)
);

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  project_no         TEXT NOT NULL,
  deal_id            TEXT REFERENCES deals(id),
  opportunity_id     TEXT REFERENCES opportunities(id),
  contact_id         TEXT NOT NULL REFERENCES contacts(id),
  company_id         TEXT REFERENCES companies(id),
  name               TEXT NOT NULL,
  address            TEXT NOT NULL DEFAULT '',
  project_type       TEXT NOT NULL DEFAULT 'standard',
  status             TEXT NOT NULL DEFAULT 'active', -- active|closed|cancelled
  original_contract  REAL NOT NULL DEFAULT 0,
  change_order_total REAL NOT NULL DEFAULT 0,
  started_at         INTEGER,
  completed_at       INTEGER,
  closed_at          INTEGER,
  created_by         TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_projects_no ON projects(project_no);
CREATE INDEX idx_projects_deal ON projects(deal_id);

CREATE TABLE draw_schedules (
  id         TEXT PRIMARY KEY,
  deal_id    TEXT REFERENCES deals(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'active', -- active|superseded
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (deal_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE INDEX idx_draws_deal ON draw_schedules(deal_id, status);
CREATE INDEX idx_draws_project ON draw_schedules(project_id, status);

CREATE TABLE draw_items (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES draw_schedules(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  milestone   TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT '',
  pct         REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  condition   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_drawitems_sched ON draw_items(schedule_id, seq);

CREATE TABLE contracts (
  id               TEXT PRIMARY KEY,
  deal_id          TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL DEFAULT 1,
  document_id      TEXT REFERENCES documents(id),
  amount           REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft',   -- draft|sent|signed|void
  signature_status TEXT NOT NULL DEFAULT 'unsigned', -- unsigned|sent|signed|declined
  provider         TEXT NOT NULL DEFAULT 'none',    -- none = not configured
  signature_ref    TEXT,
  sent_at          INTEGER,
  signed_at        INTEGER,
  created_by       TEXT REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (deal_id, version)
);

CREATE TABLE deposits (
  id          TEXT PRIMARY KEY,
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  amount      REAL NOT NULL DEFAULT 0,
  due_at      INTEGER,
  status      TEXT NOT NULL DEFAULT 'not_required',
              -- not_required|due|received|cleared
  received_at INTEGER,
  cleared_at  INTEGER,
  method      TEXT,
  reference   TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE compliance_items (
  id          TEXT PRIMARY KEY,
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 1,
  received    INTEGER NOT NULL DEFAULT 0,
  document_id TEXT REFERENCES documents(id),
  received_at INTEGER,
  updated_at  INTEGER NOT NULL,
  UNIQUE (deal_id, key)
);

-- ---------- Production ----------

CREATE TABLE crews (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  foreman_id TEXT REFERENCES users(id),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  job_no           TEXT NOT NULL,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trade            TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  stage            TEXT NOT NULL DEFAULT 'unscheduled',
                   -- unscheduled|scheduled|in_progress|punch_list|complete|invoiced|paid
  scope_snapshot   TEXT NOT NULL DEFAULT '{}',
  estimated_cost   REAL NOT NULL DEFAULT 0,
  scheduled_start  INTEGER,
  scheduled_end    INTEGER,
  crew_id          TEXT REFERENCES crews(id),
  foreman_id       TEXT REFERENCES users(id),
  started_at       INTEGER,
  completed_at     INTEGER,
  invoiced_at      INTEGER,
  closed_at        INTEGER,
  stage_entered_at INTEGER NOT NULL,
  created_by       TEXT REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (project_id, trade)
);
CREATE UNIQUE INDEX idx_jobs_no     ON jobs(job_no);
CREATE INDEX idx_jobs_stage         ON jobs(stage);
CREATE INDEX idx_jobs_project       ON jobs(project_id);
CREATE INDEX idx_jobs_schedule      ON jobs(scheduled_start);

CREATE TABLE crew_assignments (
  id        TEXT PRIMARY KEY,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  crew_id   TEXT REFERENCES crews(id),
  user_id   TEXT REFERENCES users(id),
  work_date INTEGER NOT NULL,
  role      TEXT NOT NULL DEFAULT 'crew',
  hours     REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_crewassign_job ON crew_assignments(job_id, work_date);

CREATE TABLE daily_reports (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  report_date       INTEGER NOT NULL,
  foreman_id        TEXT REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|approved
  work_completed    TEXT NOT NULL DEFAULT '',
  labor_hours       REAL NOT NULL DEFAULT 0,
  crew_size         INTEGER NOT NULL DEFAULT 0,
  materials_used    TEXT NOT NULL DEFAULT '',
  equipment_used    TEXT NOT NULL DEFAULT '',
  safety_notes      TEXT NOT NULL DEFAULT '',
  delays            TEXT NOT NULL DEFAULT '',
  blockers          TEXT NOT NULL DEFAULT '',
  photos            TEXT NOT NULL DEFAULT '[]',
  customer_comm_check INTEGER NOT NULL DEFAULT 0,
  submitted_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (job_id, report_date)
);
CREATE INDEX idx_daily_date ON daily_reports(report_date, status);

CREATE TABLE change_orders (
  id                    TEXT PRIMARY KEY,
  co_no                 TEXT NOT NULL,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id                TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'requested',
                        -- requested|priced|internal_approved|customer_presented
                        -- |customer_approved|customer_rejected|authorized|void
  requested_by          TEXT REFERENCES users(id),
  requested_at          INTEGER NOT NULL,
  estimate_id           TEXT REFERENCES estimates(id),
  internal_amount       REAL,
  customer_amount       REAL,
  priced_by             TEXT REFERENCES users(id),
  priced_at             INTEGER,
  internal_approved_by  TEXT REFERENCES users(id),
  internal_approved_at  INTEGER,
  presented_at          INTEGER,
  customer_decided_at   INTEGER,
  customer_decision_note TEXT NOT NULL DEFAULT '',
  authorized_by         TEXT REFERENCES users(id),
  authorized_at         INTEGER,
  schedule_impact       TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_co_no ON change_orders(co_no);
CREATE INDEX idx_co_project ON change_orders(project_id, status);

CREATE TABLE job_costs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES cost_categories(id),
  kind        TEXT NOT NULL DEFAULT 'actual',  -- committed|actual
  vendor_id   TEXT REFERENCES vendors(id),
  description TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL DEFAULT 0,
  occurred_at INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual|po|invoice|change_order
  source_ref  TEXT,
  recorded_by TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_costs_job ON job_costs(job_id, kind, category_id);
CREATE INDEX idx_costs_project ON job_costs(project_id, kind);

CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  invoice_no   TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  draw_item_id TEXT REFERENCES draw_items(id),
  amount       REAL NOT NULL DEFAULT 0,
  issued_at    INTEGER,
  due_at       INTEGER,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft|sent|partial|paid|void
  collected_at INTEGER,
  notes        TEXT NOT NULL DEFAULT '',
  created_by   TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_invoice_no ON invoices(invoice_no);
CREATE INDEX idx_invoices_project ON invoices(project_id, status);
CREATE INDEX idx_invoices_due ON invoices(status, due_at);

CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  received_at INTEGER NOT NULL,
  method      TEXT NOT NULL DEFAULT 'other',
  reference   TEXT NOT NULL DEFAULT '',
  recorded_by TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id   TEXT,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at);
