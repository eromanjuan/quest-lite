import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentForFirestore } from './firestore-sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');

export const DB_PATH = path.resolve(
  ROOT,
  process.env.DATABASE_PATH ?? './data/quest-lite.sqlite',
);

export type Db = Database.Database;

let instance: Db | null = null;

/** Statements that must never be built by string concatenation are prepared here. */
export function getDb(): Db {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  instance = db;
  runMigrations(db);
  // From here on every write is tracked so it can be mirrored into Firestore.
  // SQLite stays the fast local working copy; Firebase is the database of
  // record (see db/firestore-sync.ts).
  instrumentForFirestore(db);
  return db;
}

/** Test helper: point the process at a different database file. */
export function resetDbHandle(): void {
  if (instance) {
    try {
      instance.close();
    } catch {
      /* already closed */
    }
  }
  instance = null;
}

export function migrationsDir(): string {
  return path.join(here, 'migrations');
}

function runMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name as string),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
    })();
  }
}

/**
 * Run `fn` inside a single SQLite transaction. Nested calls join the outer
 * transaction (better-sqlite3 uses SAVEPOINT for nesting), so services can
 * compose without accidentally committing halfway.
 */
export function tx<T>(fn: (db: Db) => T): T {
  const db = getDb();
  return db.transaction(() => fn(db))();
}

export function now(): number {
  return Date.now();
}
