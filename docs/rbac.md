# Role-based access control

`server/core/permissions.ts` is the single source of truth. Six roles, 38
permissions.

**The UI never decides.** Every mutating route re-checks the permission with
`requirePermission(...)` before doing anything. The interface hides controls the
user cannot use — via `useAuth().can(...)` — but that is ergonomics, not
security. Removing a `can()` check from a component would expose a button; it
would not expose the operation, because the API still refuses it.

## Roles

| Key | Role | Intent |
| --- | --- | --- |
| `owner` | Owner / Administrator | Everything, including administration and audit. |
| `rep` | Prospecting Representative | Generate and qualify leads. No pricing access at all. |
| `estimator` | Estimator | Underwriting, takeoff, quotes, margin control, price book. |
| `closer` | Sales Closer | Proposals, negotiation, contracts, deposits. **Cannot alter approved pricing.** |
| `pm` | Project Manager | Scheduling, production, costs, change orders, collections. |
| `foreman` | Foreman | Field work, crew, tasks, daily reports. **No margin, profit or cost visibility.** |

## The matrix

`✓` = granted, `–` = denied.

| Permission | owner | rep | estimator | closer | pm | foreman |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Administration** |
| `admin.manage` | ✓ | – | – | – | – | – |
| `audit.view` | ✓ | – | – | – | – | – |
| `settings.manage` | ✓ | – | – | – | – | – |
| **CRM & tasks** |
| `crm.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `crm.write` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `task.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `task.write` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Prospecting** |
| `prospect.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `prospect.write` | ✓ | ✓ | ✓ | ✓ | – | – |
| `prospect.handoff` | ✓ | ✓ | ✓ | – | – | – |
| **Communications** |
| `comms.log` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `comms.send` | ✓ | ✓ | – | ✓ | – | – |
| `template.manage` | ✓ | ✓ | ✓ | ✓ | – | – |
| **Underwriting** |
| `bid.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `bid.write` | ✓ | – | ✓ | – | – | – |
| `estimate.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `estimate.write` | ✓ | – | ✓ | – | – | – |
| `estimate.release` | ✓ | – | ✓ | – | – | – |
| **Pricing** |
| `pricebook.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `pricebook.write` | ✓ | – | ✓ | – | – | – |
| `pricebook.protected_write` | ✓ | – | ✓ | – | – | – |
| `margin.request_exception` | ✓ | – | ✓ | – | – | – |
| `margin.approve_exception` | ✓ | – | – | – | – | – |
| **Sales** |
| `deal.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `deal.write` | ✓ | – | – | ✓ | – | – |
| `deal.request_repricing` | ✓ | – | ✓ | ✓ | – | – |
| `deal.mark_won` | ✓ | – | – | ✓ | – | – |
| **Production** |
| `production.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `production.write` | ✓ | – | – | – | ✓ | ✓ |
| `production.financials` | ✓ | – | – | – | ✓ | – |
| `production.log_cost` | ✓ | – | – | – | ✓ | – |
| **Change orders** |
| `changeorder.request` | ✓ | – | – | – | ✓ | ✓ |
| `changeorder.price` | ✓ | – | ✓ | – | – | – |
| `changeorder.approve_internal` | ✓ | – | ✓ | – | ✓ | – |
| `changeorder.present` | ✓ | – | – | ✓ | – | – |
| `changeorder.authorize` | ✓ | – | – | – | – | – |
| **Billing & reporting** |
| `invoice.manage` | ✓ | – | – | – | ✓ | – |
| `kpi.view` | ✓ | ✓ | ✓ | ✓ | ✓ | – |

## The four separations that matter

These are the ones the product depends on. Each is enforced on the server.

**1. A closer cannot alter approved pricing.** `estimate.write` and
`estimate.release` are estimator-only. A closer has `deal.write` — they build
proposals, draw schedules and contracts — but the quote itself is immutable in
Sales. To change a price they must use `deal.request_repricing`, which sends it
back to Underwriting. A proposal stores an `estimate_snapshot`, so sending a
proposal cannot silently reprice it later either.

**2. A foreman cannot see margin or profit.** The foreman role is the only one
without `estimate.read`, `pricebook.read`, `deal.read`, `production.financials`,
`invoice.manage` or `kpi.view`. This is defended in two places, deliberately:

- The server nulls the figures — `GET /projects/:id` returns
  `financialsRestricted: true` and no dollar values.
- The UI also refuses to render them, as a second line rather than the only one.

So a foreman who calls the API directly with their own session still gets no
financial data. That is the test that matters; the hidden UI is not.

**3. Change-order authorization is separated from production.**
`changeorder.authorize` is held **by the owner alone**. This is deliberate
segregation of duties and is worth understanding before it looks like a bug:

| Step | Who |
| --- | --- |
| Request | PM or foreman |
| Price | Estimator |
| Internal approval | Estimator or PM |
| Present to customer | Closer |
| **Authorize** | **Owner only** |

The person who schedules the extra work cannot also approve the extra spend.
The server enforces the status flow — `authorized` is only reachable from
`customer_approved`, never directly from `requested` — so an unauthorized order
cannot be created by any route, by any role.

**4. Only the owner approves margin exceptions.** `margin.approve_exception` is
owner-only. An estimator may `margin.request_exception`, but a quote below the
floor cannot release itself.

## Separation inside a single request

Even the owner cannot skip a business gate by holding every permission. The
Won gate, the margin floor, the draw-percentage total and the job-stage pipeline
are **state rules**, not permission rules — `deal.mark_won` lets you attempt the
transition, but a 422 still comes back listing the unmet requirements. Holding
every permission in the matrix does not let you mark a deal Won with an
unreceived deposit.

## Accounts

There are no seeded accounts — every workspace starts empty. People create
their own account on the **Sign up** page (`/signup`); the first account to
register becomes the **Owner**, and everyone after joins as a **Prospecting
Rep**. An Owner changes roles under Administration → Users.

**Google sign-in** covers the same flow: "Continue with Google" signs in if the
email already has an account and creates one otherwise (same Owner/Rep rules).
Google proves the email address; the account and its role are still held here.
See `docs/google-signin.md` for setup.

Legacy databases that still contain the old `*@quest.test` demo logins have
them retired automatically on boot: deactivated, de-identified, and their
passwords discarded (`purgeDemoAccounts`).

## Adding a role or permission

1. Add the key to `PERMISSIONS` with a plain-language description — the Admin
   screen renders this as the reference matrix.
2. Add it to the roles that should hold it in `ROLE_PERMISSIONS`.
3. Add `requirePermission('your.key')` to the route.
4. Add a case to `tests/authz.test.ts`.

Changing an existing role's grants takes effect immediately; `permissionsFor`
caches per role key for the life of the process, and the cache is keyed on the
role, not the user, so a changed grant requires the user's row to be re-read.
