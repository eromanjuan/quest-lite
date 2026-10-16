# Database schema

Single SQLite file, created by `server/db/migrations/001_init.sql` (875 lines,
55 tables). One data model serves all four workspaces — a prospect, a bid, a
deal and a project are separate rows, but they all hang off the same `contacts`
and `companies`, so a record entered once is never re-entered.

## Conventions

These apply everywhere and are what makes the SQL portable later.

| Convention | Detail |
| --- | --- |
| Primary keys | `id TEXT PRIMARY KEY` — prefixed ULIDs (`pr_`, `bd_`, `dl_`, `prj_`, …) from `server/core/ids.ts`. Prefixed so an id is self-describing in an audit log. |
| Timestamps | `INTEGER` epoch **milliseconds**. Not ISO strings, not SQLite `DATETIME` — epoch keeps ordering and arithmetic trivial and survives a Postgres port unchanged. |
| Booleans | `INTEGER` 0/1 with `DEFAULT 0`. SQLite has no boolean type. |
| Money | `INTEGER` cents **or** `REAL`. Every value passes through `round2` (`server/core/money.ts`) before it is written or returned, so the same inputs always produce the same cents. |
| JSON blobs | `TEXT`, parsed in the route layer before responding (`options`, `scope_snapshot`, `estimate_snapshot`, audit `before`/`after`). |
| Deletion | Almost nothing is deleted. `archived_at`, `active = 0`, and status columns keep history valid — see "No hard deletes" below. |

`PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` are set on every
connection in `server/db/database.ts`. Foreign keys being ON matters: SQLite
defaults it OFF, so a schema relying on referential integrity is silently
unenforced unless the pragma is set at connect time.

## Ownership spine

Every workspace row traces back to a company and a contact:

```
companies ─┬─ contacts ─┬─ prospects ── opportunities ── bids ── estimates
           │            ├─ deals ── proposals ── projects ── jobs ── daily_reports
           │            ├─ communications
           │            └─ tasks
           └─ vendors / subcontractors ── sub_quotes
```

`opportunities` is the Prospecting→Underwriting link row; `deals.handoff_project_id`
is the Sales→Production link. There is no duplicated contact anywhere.

## Access control

| Table | Purpose |
| --- | --- |
| `roles` | 6 seeded roles. `key` is the stable identifier; the label can change without breaking grants. |
| `permissions` | ~40 keys (`estimate.read`, `production.financials`, `changeorder.authorize`, …). |
| `role_permissions` | The matrix. **Enforced on the server per request** via `requirePermission` — never by hiding UI. |
| `users` | `email` is UNIQUE. `password_hash` is scrypt with a per-user salt. |
| `sessions` | DB-backed, not JWT. Token is httpOnly and its hash is stored, so a session can be revoked. |
| `audit_events` | Append-only. `actor`, `action`, `entity_type`, `entity_id`, `summary`, `before`, `after`, `meta`. |

## Configuration (admin-editable reference data)

`lead_sources`, `territories`, `timing_buckets`, `dispositions`, `cost_categories`,
`benchmarks`, `settings`, `communication_templates`, `scope_templates`,
`won_gate_configs`, `price_book_items`, `price_book_revisions`.

`dispositions` is deliberately keyed by `(workspace, key)` with a UNIQUE index and
is **never deleted** — historical rows must keep a valid reference, so a
disposition is renamed or deactivated instead. `won_gate_configs` is UNIQUE on
`project_type`, so each project type has exactly one gate definition.

`price_book_revisions` keeps every prior price and tax class with who changed it
and when, so a protected price can be traced rather than merely overwritten.

## Prospecting

| Table | Notes |
| --- | --- |
| `prospects` | Lead stage, source, territory, temperature, assigned rep, disposition. |
| `opportunities` | Qualified stage. Feeds `bids` and (via deal) `estimates`. |
| `drip_campaigns` / `drip_enrollments` / `drip_events` | Follow-up automation. UNIQUE `(campaign_id, prospect_id)` prevents double-enrolling. |

## Underwriting

| Table | Notes |
| --- | --- |
| `bids` | `bid_no` UNIQUE. Trade, project address, estimator, status. |
| `scope_responses` | Answers against a `scope_templates` row. UNIQUE `(bid_id, template_id)` so a template is answered once. |
| `plan_revisions` | Plan uploads with a revision number. UNIQUE `(bid_id, revision_no)`. |
| `takeoff_items` | Measurements feeding the calc. |
| `sub_quotes` | Subcontractor pricing. |
| `estimates` | The priced quote. UNIQUE `(bid_id, version)` — **versions are immutable**; a change creates a new version rather than editing the old one. |
| `estimate_lines` | Selling and cost lines for one estimate version. |
| `margin_approvals` | A quote below the margin floor cannot be released without an approved row here. |

## Sales

| Table | Notes |
| --- | --- |
| `deals` | `deal_no` UNIQUE. Stage, closer, expected close, lost reason. |
| `proposals` | UNIQUE `(deal_id, version)`. `options` and the `estimate_snapshot` are stored as JSON so a sent proposal can never silently change when the estimate is revised. |
| `draw_schedules` / `draw_items` | Percentages must total exactly 100; the allocation gives the remainder to the final part so the parts always re-sum to the contract value. |
| `contracts` | UNIQUE `(deal_id, version)`. |
| `deposits` | UNIQUE `(deal_id, key)`. |
| `compliance_items` | Insurance/licence documents required before Won. |

## Production

| Table | Notes |
| --- | --- |
| `projects` | `project_no` UNIQUE. Created by the Won handoff, never by hand. |
| `jobs` | UNIQUE `(project_id, trade)` — a project cannot get two framing jobs. `scope_snapshot` carries the sold scope and cost basis forward so production never re-enters it. |
| `crew_assignments` | Crew to job. |
| `daily_reports` | **UNIQUE `(job_id, report_date)`** — an upsert per date, so a foreman cannot accidentally file two reports for one day. |
| `change_orders` | `co_no` UNIQUE. Status flows `requested → priced → internal_approved → customer_presented → customer_approved → authorized`. |
| `job_costs` | `kind` is `committed` or `actual`. Committed is a commitment not yet expensed, so projected cost = actual + committed. |
| `invoices` / `payments` | `invoice_no` UNIQUE. An invoice with payments cannot be deleted (409). |
| `draw_schedules` | Reused for projects. |

## Cross-cutting

`tasks` (linkable to any entity via nullable FKs), `communications` (log plus
draft/live status), `documents`, `notifications`.

## Integrity rules the schema encodes

These are the constraints that stop a wrong state from being stored at all,
rather than being caught in a route:

- **One framing job per project** — `UNIQUE (project_id, trade)`.
- **One daily report per job per day** — `UNIQUE (job_id, report_date)`.
- **Estimate and proposal versions are immutable** — UNIQUE on
  `(bid_id, version)` and `(deal_id, version)`.
- **A task must link somewhere** —
  `CHECK (deal_id IS NOT NULL OR project_id IS NOT NULL)`.
- **One Won gate per project type** — `UNIQUE (won_gate_configs.project_type)`.
- **Config keys are unique and stable** — separate UNIQUE indexes on every
  config table's `key`.

## No hard deletes

Deletion is refused (409) or converted to a state change:

- A task that is `done` cannot be deleted.
- An invoice with payments cannot be deleted.
- A disposition is deactivated, never removed.
- Contacts and companies are archived, not deleted.
- Estimates and proposals are superseded, never edited in place.

The reason is traceability: an audit entry pointing at a deleted row is a
dead end, and a financial record that vanishes cannot be reconciled.

## Moving off SQLite

The driver is isolated behind `server/db/database.ts` (`getDb()`, `tx()`), and
the SQL uses a small dialect subset. A Postgres port means:

1. `better-sqlite3` → `pg`, with `tx()` wrapping a client instead of
   `db.transaction()`.
2. Widen `id TEXT` → `id BIGINT`/`TEXT` (ULIDs already fit `TEXT`).
3. `INTEGER` epoch ms stays as-is.
4. Replace `json_extract(...)` reads with `jsonb` operators.
5. Move `AUTOINCREMENT` sequences to `GENERATED ALWAYS AS IDENTITY`.

Nothing outside that layer should need to change. This matters because SQLite
constrains hosting to a single instance with a persistent disk — see
`docs/deployment.md`.
