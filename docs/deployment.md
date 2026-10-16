# Deployment

Quest Lite is a React SPA (`web/`) and an Express API (`server/`). This document
covers the split deployment onto Firebase Hosting at `quest-lite.web.app`.

## 1. What the Spark (free) plan can and cannot do

Firebase's Spark plan is genuinely free, and it is enough to put the app online —
but it is **static hosting only**. It cannot run:

| Firebase capability | Spark plan | Effect |
| --- | --- | --- |
| Hosting static files | ✅ | Serves the built SPA at `quest-lite.web.app` |
| Cloud Functions | ❌ Blaze only | No serverless API |
| Cloud Run | ❌ Blaze only | No container API |
| Cloud SQL | ❌ Blaze only | No managed Postgres/MySQL |

Firebase's own compute tiers (`apphosting`, Functions, Cloud Run) are behind the
Blaze pay-as-you-go plan, so there is no way to host the Express API on Firebase
without enabling billing.

This app needs a real server. Every critical operation — margin floors, the Won
gate, change-order authorization, role checks — is enforced in Express against a
SQLite database. Moving that logic into the browser would remove the security
boundary, so it is not an option.

**The deployment is therefore split:** Firebase Hosting serves the SPA, and the
API runs on a separate free-tier host. The two talk cross-origin.

## 2. The two pieces

```
Browser ──► https://quest-lite.web.app      (Firebase Hosting, Spark plan)
                 │  static SPA, no data
                 │  fetch('/api/...', {credentials:'include'})
                 ▼
            https://<api-host>              (Express + SQLite)
                 │  session cookie: SameSite=None; Secure
                 ▼
            /data/quest-lite.sqlite         (mounted volume)
```

Cross-origin credentialed requests have hard browser rules that this deployment
respects explicitly:

- The API must reply with `Access-Control-Allow-Origin` set to the **exact**
  origin — a `*` wildcard is rejected when credentials are used. See
  `server/core/cors.ts`.
- The session cookie must be `SameSite=None; Secure`, or the browser silently
  drops it and every request looks signed out. See `sessionCookieOptions()`.
- The SPA must send `credentials: 'include'`. See `web/src/lib/api.ts`.

## 3. Deploy the SPA to Firebase Hosting

1. Log in (this opens a browser and must be done once, interactively):

   ```bash
   firebase login
   ```

2. The project is already pinned in `.firebaserc` to `quest-lite`.

3. Build and deploy:

   ```bash
   npm run deploy:hosting
   ```

   This runs `vite build` into `dist/`, then `firebase deploy --only hosting`.
   Firebase Hosting writes back the real URL when the site is live; the custom
   domain `quest-lite.web.app` is the default for project `quest-lite`.

4. Tell the SPA where the API lives by building with the API origin:

   ```bash
   VITE_API_BASE_URL=https://<your-api-host> npm run deploy:hosting
   ```

   `web/src/lib/api.ts` reads `VITE_API_BASE_URL` at build time. Leave it unset
   for a same-origin deployment (the Vite dev proxy, or serving the SPA from the
   API itself) and all requests stay on `/api` relative paths.

## 4. Host the API on a free tier

`Dockerfile` builds the API image. `render.yaml` is a ready blueprint for
Render's free web service — the most straightforward free Node host. The same
image runs on Fly.io, Railway, Koyeb, or Cloud Run once on Blaze.

Using the Render blueprint:

1. Push this directory to a git repository.
2. In Render, create a **New → Blueprint**, select the repo. Render reads
   `render.yaml` and creates the service.
3. Note the service URL, e.g. `https://quest-lite-api.onrender.com`.
4. Redeploy the SPA with `VITE_API_BASE_URL` set to that URL.

Using the image directly on any Docker host:

```bash
docker build -t quest-lite-api .
docker run -p 8080:8080 \
  -e SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  -e CORS_ORIGINS=https://quest-lite.web.app \
  -v quest-data:/data \
  -d quest-lite-api
```

Required environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | **Yes** in production | A dev fallback is used otherwise; that is not safe for a real deployment. |
| `CORS_ORIGINS` | Yes for the split deployment | Comma-separated exact origins. Leave empty for same-origin. |
| `DATABASE_PATH` | Recommended | Defaults to `./data/quest-lite.sqlite`. Point it at the mounted volume. |
| `UPLOAD_DIR` | Recommended | Where uploaded files are written. Keep it on the same volume. |
| `COMMS_FORCE_TEST_MODE` | Recommended | `1` keeps SMS/email in draft mode. Set to `0` only after configuring a real provider. |

## 5. Persistence — read this before going live

The API uses SQLite via `better-sqlite3`. SQLite is a real, durable database,
but **it needs a filesystem that persists**.

- **Docker with a named volume** (`-v quest-data:/data`) — persistent. ✅
- **Render free tier** — the disk is **ephemeral**. Every deploy or restart
  recreates it, and the database returns to its seeded state. Fine for a demo or
  a screenshot; **not** acceptable for real customer records.
- **Render paid instance** — offers a persistent disk. Add one and point
  `DATABASE_PATH` at it.
- **Cloud Run / App Hosting** (Blaze) — attach a mounted volume, or move to
  Cloud SQL.

For anything holding real data, either pay for a persistent disk or move the
database to Postgres. The SQL in `server/db/migrations/001_init.sql` uses a small
SQLite-specific subset (notably `INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT`
timestamps as epoch milliseconds, and JSON stored as `TEXT`). Porting means
swapping the driver (`better-sqlite3` → `pg`), widening the id columns to `BIGINT`
or `TEXT`, and replacing the `json_extract` reads with `jsonb`. Every query goes
through `server/db/database.ts` and `tx()`, so the change stays contained in one
layer rather than spreading across the route modules.

## 6. Verify it works

There is a scripted check for the cross-origin layer, which is the part that
fails silently:

```bash
npm run deploy:check -- https://<your-api-host>
```

It runs `scripts/check-deploy.mjs` and asserts thirteen things, including the
two that are easy to get wrong and impossible to distinguish from a signed-out
UI: that the allow-list does **not** act as a wildcard for unlisted origins, and
that a cookie replayed on a real authenticated request still authenticates. Run
it against the deployed API before trusting any browser behaviour.

The manual checks worth doing once, because each proves a different layer:

1. **SPA loads** — `https://quest-lite.web.app` renders the sign-in screen.
2. **API reachable** — `https://<api-host>/api/health` returns
   `{"ok":true,...}`. Its `corsOrigins` field lists the allow-list the API is
   actually using, which is the fastest way to diagnose a CORS failure.
3. **CORS + cookie together** — sign in from the SPA. A CORS-only failure shows
   as a network error in the browser console; a cookie failure shows as a 401
   with "Not signed in" on the very next request even though login returned 200.
   Those two failures look identical from the UI, so check the console.
4. **Authorization holds** — sign in as a Foreman and confirm no margin,
   profit, or cost figure appears anywhere in Production. The server strips
   them (`financialsRestricted: true`), so this is a real check that the
   deployed API is enforcing roles, not just the UI hiding them.
5. **Won gate** — try to mark a deal Won with a requirement unmet. The deployed
   API must return 422 with the blocker list rather than creating the job.

There are no shared demo credentials: create accounts on the Sign up page —
the first one becomes the Owner. To check a restricted role, sign up a second
account and have the Owner change its role. To automate the smoke scripts, set
`CHECK_EMAIL` and `CHECK_PASSWORD` to an existing account:

```bash
CHECK_EMAIL=you@company.com CHECK_PASSWORD=… npm run deploy:check
```

Data lives in Firestore (see docs/firebase.md); `/api/health` reports the
sync state, so a `firestore.enabled: false` there means the deployment is
running on its local copy only.

## 7. The same-origin alternative

If you would rather avoid cross-origin entirely, the API can serve the built SPA
from `dist/` — `server/app.ts` does this automatically when
`NODE_ENV=production`. Deploy a single service that runs:

```bash
npm run build && npm start
```

That gives one origin, `Lax` cookies, and no CORS configuration at all. The
trade-off is that the site is then at the API host's URL rather than
`quest-lite.web.app`. Cross-origin is only needed because the target is a
Firebase Hosting domain.

## 8. What is not deployed

Honesty about scope, since these are easy to mistake for working features:

- **No SMS, email, e-signature, or payment integration is live.** No provider
  keys are configured, so the app records communication drafts and manual
  signature/payment entries. It never reports a message as delivered. Live mode
  requires setting `SMS_PROVIDER`/`EMAIL_PROVIDER` and their keys, and setting
  `COMMS_FORCE_TEST_MODE=0`. See `docs/integrations.md`.
- **Demo data is present** if you ran `npm run db:seed`. The Admin → Integrations
  screen flags this. Do not present it as production records.
- **The database is single-instance SQLite.** It does not scale horizontally, and
  two containers writing to different volumes will silently diverge.
