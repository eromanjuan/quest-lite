import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, now } from '../db/database.js';
import { newId } from '../core/ids.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
export const SESSION_COOKIE = 'ql_session';

/** The cookie carries the raw token; only its SHA-256 lands in the database. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: string, ip?: string, ua?: string): string {
  const token = randomBytes(32).toString('hex');
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), userId, now(), now() + SESSION_TTL_MS, ip ?? null, ua ?? null);
  return token;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  active: number;
}

export function resolveSession(token: string | undefined): SessionUser | null {
  if (!token || token.length < 32) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.name, u.role_key, u.active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(hashToken(token)) as any;
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
    return null;
  }
  if (!row.active) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role_key, active: row.active };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function pruneSessions(): number {
  const info = getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return info.changes;
}

/** Constant-time compare used for any secret compared outside the DB. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function newRequestId(): string {
  return newId('req');
}
