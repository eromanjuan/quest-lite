# Firebase integration

Quest Lite stores its data in **Firebase Firestore** — project `quest-lite`
(https://console.firebase.google.com/u/0/project/quest-lite/overview). The API
still speaks SQL internally, but SQLite is now a *local working copy* of
Firestore rather than the system of record.

```
browser ──► Express API ──► SQLite working copy ◄──sync──► Firestore (quest-lite)
```

| Concern | Where it lives |
| --- | --- |
| All application data (55 tables) | Firestore collections, one per table |
| Query execution (the ~700 prepared statements) | Local SQLite copy — fast, offline-capable |
| Accounts & passwords | `users` table, mirrored to the `users` collection |
| Sessions | Local only (never synced — they are tokens, not data) |
| Schema migrations | Local only (`schema_migrations`) |

## How the sync works

Implemented in `server/db/firebase.ts` (credentials) and
`server/db/firestore-sync.ts` (the sync itself).

* **On boot** every synced collection is pulled into SQLite — the cloud wins —
  and any table Firestore does not have yet is pushed up. So the first run
  uploads the existing local data, and later runs adopt whatever the console
  (or another instance) holds.
* **On every write** the statement's table is marked dirty; a serialized
  background chain pushes changed tables back to Firestore, whole table at a
  time. No request ever waits on the network.
* **Shape**: collection name = table name, document id = the row's primary key
  (`role_permissions(role_key, permission)` → `role_permissions/rep|crm.read`,
  url-encoded). Columns map 1:1 to document fields; `BLOB`s are stored as
  `{ "__b64": … }`.
* If Firebase is unreachable the app keeps running on its local copy, warns
  once, and retries on the next write. Nothing in the request path breaks.

`/api/health` reports the state:

```json
{ "ok": true, "firestore": { "enabled": true, "projectId": "quest-lite",
  "booted": true, "syncedTables": 41, "pendingTables": 0, "lastError": null } }
```

## Credentials

Resolved in this order (see `server/db/firebase.ts`):

1. `FIREBASE_SERVICE_ACCOUNT` — a key-file path, or the JSON itself
2. `./firebase-service-account.json` in the project root ← currently used
3. Application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`, or the
   attached account when running on Google Cloud)

**Treat the service-account key like a password.** It grants full access to
the project. Anyone with the repository has that access; rotate the key from
Firebase console → Project settings → Service accounts if it ever leaks, and
prefer env-provided credentials in deployments (Render: add the JSON as a
secret and point `FIREBASE_SERVICE_ACCOUNT` at it).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIRESTORE_SYNC` | `1` | `0` disables Firebase entirely (used by the test suite) |
| `FIREBASE_SERVICE_ACCOUNT` | — | Key file path or inline JSON |
| `DATABASE_PATH` | `./data/quest-lite.sqlite` | Local working copy location |

## Accounts and roles

There are no seeded accounts. The Sign up page (`/signup`) creates them: the
first account becomes the **Owner**, everyone after joins as a **Prospecting
Rep**. Legacy `*@quest.test` demo logins are retired on every boot, locally and
in Firestore. See `docs/rbac.md`.

## Operational notes

* **Multiple instances** (e.g. Render autoscaling): conflict resolution is
  last-writer-wins per table. Quest Lite assumes a single API instance, as in
  `render.yaml`.
* **Large collections** are read in one query at boot; tables are pushed in
  batches of 400 writes.
* **Manual edits in the console** are adopted at the next boot; edits made by
  the app after that win until the next restart.
* Firebase **Auth is not used** — sign-in is handled by the Express API with
  scrypt-hashed passwords and server-side sessions, so roles and permissions
  stay enforced in one place.
