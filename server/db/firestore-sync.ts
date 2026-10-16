/**
 * Firestore sync — Firebase is the database of record for Quest Lite.
 *
 * The Express API keeps using SQL (hundreds of prepared statements across
 * server/routes), but SQLite is now a *local working copy* of Firestore rather
 * than the system of record:
 *
 *   • on boot every synced collection is pulled into SQLite (cloud wins);
 *   • every write is tracked by table and pushed back to Firestore, whole
 *     tables at a time, serialized so pushes never interleave.
 *
 * One collection per table, one document per row, document id = the row's
 * primary key (composite keys are joined with "|", url-encoded). This keeps the
 * data legible in the Firebase console and the mapping trivially reversible.
 *
 * Design constraints that shaped this file:
 *   • better-sqlite3 is synchronous, the Firestore SDK is not — writes mark a
 *     table dirty and an async chain pushes later, so no route ever awaits the
 *     network;
 *   • the app must still boot and run when Firebase is unreachable (offline
 *     laptop, revoked key): every failure degrades to local-only with a warning;
 *   • tests must never touch the network: FIRESTORE_SYNC=0 disables all of it.
 */
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Db } from './database.js';
import { firestoreOrNull, firestoreSyncRequested, firebaseStatus } from './firebase.js';

/** Never leave the process: migrations are local bookkeeping, sessions are tokens. */
const LOCAL_ONLY = new Set(['schema_migrations', 'sessions']);

const WRITE_SQL =
  /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from|create\s+(?:temp(?:orary)?\s+)?table(?:\s+if\s+not\s+exists)?|drop\s+table(?:\s+if\s+exists)?|alter\s+table)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;

const BATCH_LIMIT = 400; // WriteBatch caps at 500 ops; leave headroom.
const BOOT_TIMEOUT_MS = 8_000;

let dbRef: Db | null = null;
let dirty = new Set<string>();
let booted = false;
let bootPromise: Promise<void> | null = null;
let chain: Promise<void> = Promise.resolve();
let lastPushed = new Map<string, string>();
let lastError: string | null = null;
const warnedAt = new Map<string, number>();

/* ------------------------------------------------------------------ */
/* Value + id encoding                                                 */
/* ------------------------------------------------------------------ */

/** SQLite value → something Firestore accepts (no undefined, no Buffers). */
function encodeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v)) return { __b64: v.toString('base64') };
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Firestore value → SQLite value. Reverses encodeValue. */
function decodeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__b64 === 'string') return Buffer.from(o.__b64, 'base64');
    // A manually created doc may hold a Firestore Timestamp.
    if (typeof (o as { toMillis?: () => number }).toMillis === 'function') {
      return (o as { toMillis: () => number }).toMillis();
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/** Row key → Firestore document id. Firestore forbids "/", "." and "..". */
function docIdFor(parts: unknown[]): string {
  const id = parts.map((p) => encodeURIComponent(p === null || p === undefined ? '' : String(p))).join('|');
  if (id === '' ) return '_';
  if (/^__.*__$/.test(id)) return `x${id}`; // reserved for internal wildcards
  return id;
}

function decodeDocId(raw: string): string {
  try {
    return raw
      .split('|')
      .map((p) => decodeURIComponent(p))
      .join('|');
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------------ */
/* Table introspection                                                 */
/* ------------------------------------------------------------------ */

function tableExists(db: Db, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

function describeTable(db: Db, table: string): { columns: string[]; pk: string[] } {
  const info = db.pragma(`table_info("${table}")`) as Array<{ name: string; pk: number }>;
  const columns = info.map((c) => c.name);
  const pk = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return { columns, pk };
}

export function syncTables(db: Db): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((t) => !LOCAL_ONLY.has(t));
}

function snapshotHash(db: Db, table: string): string {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Write tracking                                                      */
/* ------------------------------------------------------------------ */

function tablesTouched(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(WRITE_SQL)) {
    if (/\btemp(?:orary)?\b/i.test(m[0])) continue; // temp tables are process-local
    out.add(m[1]);
  }
  return [...out];
}

function markDirty(table: string): void {
  if (!firestoreSyncRequested()) return;
  if (LOCAL_ONLY.has(table)) return;
  if (dirty.has(table)) return;
  dirty.add(table);
  if (booted) scheduleFlush();
}

/**
 * Wrap prepare/exec on the shared handle so every mutating statement reports
 * the tables it touched. Reads are untouched (their SQL matches nothing).
 */
export function instrumentForFirestore(db: Db): void {
  dbRef = db;
  const anyDb = db as unknown as Record<string, unknown>;
  if (anyDb.__qlFirestoreInstrumented) return;
  anyDb.__qlFirestoreInstrumented = true;

  const prepare = (db.prepare as (sql: string) => unknown).bind(db);
  (db as unknown as Record<string, unknown>).prepare = (sql: string) => {
    const stmt = prepare(sql) as Record<string, unknown>;
    const tables = tablesTouched(sql);
    if (tables.length) {
      for (const name of ['run', 'get', 'all', 'iterate'] as const) {
        const original = stmt[name];
        if (typeof original !== 'function') continue;
        stmt[name] = (...args: unknown[]) => {
          const result = (original as (...a: unknown[]) => unknown).apply(stmt, args);
          for (const t of tables) markDirty(t);
          return result;
        };
      }
    }
    return stmt;
  };

  const exec = (db.exec as (sql: string) => void).bind(db);
  (db as unknown as Record<string, unknown>).exec = (sql: string) => {
    const result = exec(sql);
    for (const t of tablesTouched(sql)) markDirty(t);
    return result;
  };

  // Kick off the cloud sync in the background; callers that must wait use
  // firestoreReady(). Tests (FIRESTORE_SYNC=0) resolve immediately.
  if (!bootPromise) bootPromise = syncOnBoot(db);
}

/** Resolves once the boot pull/push has finished (or sync is disabled). */
export async function firestoreReady(): Promise<void> {
  if (bootPromise) await bootPromise;
}

/** Wait for every queued push to land in Firestore. */
export async function flush(): Promise<void> {
  await firestoreReady();
  await scheduleFlush();
}

/* ------------------------------------------------------------------ */
/* Boot: pull from Firestore, push what the cloud did not have         */
/* ------------------------------------------------------------------ */

async function syncOnBoot(db: Db): Promise<void> {
  if (!firestoreSyncRequested()) {
    boot();
    return;
  }
  const fs = firestoreOrNull();
  if (!fs) {
    boot();
    warnOnce('init', firebaseStatus().error ?? 'Firestore is not initialised.');
    return;
  }
  try {
    const reachable = await withTimeout(
      fs.collection('quest_lite').doc('connectivity').get(),
      BOOT_TIMEOUT_MS,
      'connection check',
    );
    if (!reachable) {
      boot();
      warnOnce('connectivity', `Firestore unreachable after ${BOOT_TIMEOUT_MS / 1000}s — running locally, will keep retrying on writes.`);
      return;
    }
  } catch {
    boot();
    warnOnce('connectivity', 'Firestore unreachable — running locally, will keep retrying on writes.');
    return;
  }

  for (const table of syncTables(db)) {
    if (!tableExists(db, table)) continue;
    try {
      const pulled = await pullTable(db, fs, table);
      if (pulled) {
        // Cloud data is now local, byte for byte — remember it so the first
        // flush does not rewrite documents that already match.
        lastPushed.set(table, snapshotHash(db, table));
        dirty.delete(table);
      }
    } catch (err) {
      warnOnce(`pull:${table}`, `pull of "${table}" failed: ${message(err)}`);
    }
  }
  boot();
}

function boot(): void {
  booted = true;
  if (dirty.size) scheduleFlush();
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch (err) {
    throw new Error(`${what}: ${message(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pullTable(db: Db, fs: Firestore, table: string): Promise<boolean> {
  const snap = await fs.collection(table).get();
  if (snap.empty) return false; // cloud has nothing yet → local stays, gets pushed

  const { columns, pk } = describeTable(db, table);
  const rows = snap.docs.map((doc) => reviveDoc(doc.id, doc.data(), columns, pk));
  replaceRows(db, table, columns, rows);
  return true;
}

function reviveDoc(
  id: string,
  data: Record<string, unknown>,
  columns: string[],
  pk: string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (columns.includes(k)) row[k] = decodeValue(v);
  }
  if (pk.length === 1 && (row[pk[0]] === null || row[pk[0]] === undefined)) {
    row[pk[0]] = decodeDocId(id);
  }
  return row;
}

function replaceRows(
  db: Db,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): void {
  // Parent rows may be re-created after their children in a foreign table;
  // enforcement happens when the pragma is restored, not mid-swap.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM "${table}"`).run();
      if (table === 'users') db.prepare(`DELETE FROM "sessions"`).run();
      const insert = db.prepare(
        `INSERT INTO "${table}" ("${columns.join('", "')}") VALUES (${columns.map(() => '?').join(', ')})`,
      );
      const skipped: string[] = [];
      for (const row of rows) {
        try {
          insert.run(columns.map((c) => coerceForSql(row[c])));
        } catch (err) {
          skipped.push(`${describeDoc(row, columns)} — ${message(err)}`);
        }
      }
      if (skipped.length) {
        console.warn(
          `[firestore] ${skipped.length} document(s) in "${table}" do not fit the local schema and were skipped:\n  - ${skipped.slice(0, 5).join('\n  - ')}`,
        );
      }
    })();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

function coerceForSql(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

function describeDoc(row: Record<string, unknown>, columns: string[]): string {
  const keys = ['id', 'key', 'email', 'name'].filter((k) => columns.includes(k) && row[k] != null);
  if (!keys.length) return '(row)';
  return keys.map((k) => `${k}=${String(row[k])}`).join(' ');
}

/* ------------------------------------------------------------------ */
/* Push: whole tables, serialized                                       */
/* ------------------------------------------------------------------ */

function scheduleFlush(): Promise<void> {
  chain = chain.then(runFlush);
  return chain;
}

async function runFlush(): Promise<void> {
  if (!firestoreSyncRequested() || !dirty.size) return;
  const fs = firestoreOrNull();
  if (!fs || !dbRef) return;

  const tables = [...dirty];
  dirty.clear();

  for (const table of tables) {
    try {
      await pushTable(dbRef, fs, table);
      lastError = null;
    } catch (err) {
      dirty.add(table); // retried on the next flush
      lastError = `${table}: ${message(err)}`;
      warnOnce(`push:${table}`, `push of "${table}" failed — ${message(err)}`);
    }
  }
}

async function pushTable(db: Db, fs: Firestore, table: string): Promise<void> {
  if (!tableExists(db, table)) return;
  const hash = snapshotHash(db, table);
  if (lastPushed.get(table) === hash) return; // unchanged since the last sync

  const { columns, pk } = describeTable(db, table);
  const rows = (
    pk.length
      ? db.prepare(`SELECT * FROM "${table}"`).all()
      : db.prepare(`SELECT rowid AS __rowid__, * FROM "${table}"`).all()
  ) as Array<Record<string, unknown>>;

  const desired = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const parts = pk.length ? pk.map((k) => row[k]) : [row.__rowid__];
    const data: Record<string, unknown> = {};
    for (const c of columns) data[c] = encodeValue(row[c]);
    if (!pk.length) data.__rowid__ = row.__rowid__;
    desired.set(docIdFor(parts), data);
  }

  const col = fs.collection(table);
  const existing = await col.listDocuments();
  const existingIds = new Set(existing.map((d) => d.id));

  let batch = fs.batch();
  let ops = 0;
  const commit = async () => {
    if (!ops) return;
    await batch.commit();
    batch = fs.batch();
    ops = 0;
  };

  for (const id of existingIds) {
    if (!desired.has(id)) {
      batch.delete(col.doc(id));
      if (++ops >= BATCH_LIMIT) await commit();
    }
  }
  for (const [id, data] of desired) {
    batch.set(col.doc(id), data);
    if (++ops >= BATCH_LIMIT) await commit();
  }
  await commit();

  lastPushed.set(table, hash);
}

/* ------------------------------------------------------------------ */
/* Reporting + housekeeping                                             */
/* ------------------------------------------------------------------ */

export interface FirestoreHealth {
  enabled: boolean;
  projectId: string | null;
  booted: boolean;
  syncedTables: number;
  pendingTables: number;
  lastError: string | null;
}

export function firestoreHealth(): FirestoreHealth {
  const s = firebaseStatus();
  return {
    enabled: s.enabled,
    projectId: s.projectId,
    booted,
    syncedTables: lastPushed.size,
    pendingTables: dirty.size,
    lastError,
  };
}

function warnOnce(key: string, text: string): void {
  const now = Date.now();
  const at = warnedAt.get(key) ?? 0;
  if (now - at < 60_000) return;
  warnedAt.set(key, now);
  console.warn(`[firestore] ${text}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Short-lived scripts (npm run db:seed, db:reset) must not exit before their
// queued pushes reach the cloud. beforeExit re-fires while work is pending, so
// scheduling the drain here is safe.
process.once('beforeExit', () => {
  void firestoreReady().then(() => scheduleFlush()).catch(() => undefined);
});
