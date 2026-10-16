import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { getDb, now, tx } from '../db/database.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/session.js';
import { sessionCookieOptions } from '../core/cors.js';
import { requireAuth, currentUser, requirePermission } from '../auth/middleware.js';
import { permissionsFor, ROLES, PERMISSIONS } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { ah, parseBody, badRequest, conflict, notFound } from '../http/helpers.js';
import { newId } from '../core/ids.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

function publicUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role_key,
    roleLabel: (ROLES as any)[row.role_key]?.name ?? row.role_key,
    active: row.active,
    lastLoginAt: row.last_login_at,
    permissions: [...permissionsFor(row.role_key)],
  };
}

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(email.trim()) as any;

    // Same message for unknown user and bad password — no account probing.
    const ok = row && row.active && (await verifyPassword(password, row.password_hash));
    if (!ok) {
      audit({
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: row?.id ?? email,
        summary: `Failed sign-in for ${email}`,
        meta: { ip: req.ip },
      });
      throw badRequest('Email or password is incorrect.');
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id);
    const token = createSession(row.id, req.ip, req.get('user-agent'));
    // SameSite/Secure differ between same-origin and split (Firebase Hosting)
    // deployments — see server/core/cors.ts.
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(1000 * 60 * 60 * 24 * 14));
    audit({
      actorId: row.id,
      actorName: row.name,
      action: 'auth.login',
      entityType: 'user',
      entityId: row.id,
      summary: `${row.name} signed in`,
    });
    res.json({ user: publicUser(row) });
  }),
);

const signupSchema = z.object({
  email: z.string().trim().min(5).max(200).email('Enter a valid email address.'),
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
});

/**
 * Self-serve sign-up.
 *
 * The workspace starts empty — there is no seeded demo team — so the first
 * account to register becomes the Owner. Everyone after starts as a
 * Prospecting Rep, which an Owner can change under Administration → Users.
 */
authRouter.post(
  '/signup',
  ah(async (req, res) => {
    const input = parseBody(signupSchema, req.body);
    const db = getDb();
    const exists = db
      .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
      .get(input.email);
    if (exists) {
      throw conflict('An account with that email already exists. Try signing in instead.');
    }

    const activeCount = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as any)
      .n;
    const role = activeCount === 0 ? 'owner' : 'rep';

    const hash = await hashPassword(input.password);
    const id = newId('usr');
    tx((d) => {
      d.prepare(
        `INSERT INTO users (id, email, name, password_hash, role_key, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, input.email.toLowerCase(), input.name, hash, role, now(), now());
    });

    const token = createSession(id, req.ip, req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(1000 * 60 * 60 * 24 * 14));
    audit({
      actorId: id,
      actorName: input.name,
      action: 'auth.signup',
      entityType: 'user',
      entityId: id,
      summary: `${input.name} signed up as ${(ROLES as any)[role].name}`,
      after: { email: input.email, role },
    });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    res.status(201).json({ user: publicUser(row) });
  }),
);

/* ------------------------------------------------------------------ */
/* Google sign-in                                                       */
/* ------------------------------------------------------------------ */

/**
 * Accounts are still created and governed here — Google only proves "this
 * person really owns that email". One endpoint covers both cases the user
 * sees: sign in when the email already has an account, sign up (as Owner for
 * the very first account, otherwise as a Prospecting Rep) when it does not.
 *
 * Configure with GOOGLE_CLIENT_ID (comma-separated for local + production).
 * Until then the button stays hidden and these routes say so.
 */
function googleClientIds(): string[] {
  return (process.env.GOOGLE_CLIENT_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** No secret is needed — the client only verifies Google-issued ID tokens. */
let googleVerifier: OAuth2Client | null = null;

/** Lets the SPA hide the button (and explain itself) when not configured. */
authRouter.get(
  '/google/status',
  ah(async (_req, res) => {
    const ids = googleClientIds();
    res.json({ enabled: ids.length > 0, clientId: ids[0] ?? null });
  }),
);

authRouter.post(
  '/google',
  ah(async (req, res) => {
    const audience = googleClientIds();
    if (!audience.length) {
      throw badRequest('Google sign-in is not configured on this server.');
    }
    const { credential } = parseBody(
      z.object({ credential: z.string().min(20).max(8192) }),
      req.body,
    );

    googleVerifier ??= new OAuth2Client();
    let payload: TokenPayload;
    try {
      const ticket = await googleVerifier.verifyIdToken({ idToken: credential, audience });
      payload = ticket.getPayload() ?? ({} as TokenPayload);
    } catch (err) {
      // Deliberately generic: never echo token or Google error detail to a client.
      console.warn('[auth] Google token rejected:', err instanceof Error ? err.message : err);
      throw badRequest('Google sign-in failed — that sign-in attempt could not be verified.');
    }

    const email = payload.email?.trim().toLowerCase() ?? '';
    if (!email) throw badRequest('Your Google account did not share an email address.');
    if (payload.email_verified === false) {
      throw badRequest('Verify the email address on your Google account, then try again.');
    }

    const db = getDb();
    let row = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as any;

    if (row && !row.active) {
      throw badRequest('This account has been deactivated. Ask an administrator to restore access.');
    }

    const displayName = payload.name?.trim() || email.split('@')[0];
    if (!row) {
      const activeCount = (
        db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as any
      ).n;
      const role = activeCount === 0 ? 'owner' : 'rep';
      const id = newId('usr');
      // password_hash is NOT NULL; the sentinel marks a Google-managed account.
      // verifyPassword() rejects it, so the account can only use Google sign-in
      // until an administrator sets a password (PATCH /auth/users/:id).
      tx((d) => {
        d.prepare(
          `INSERT INTO users (id, email, name, password_hash, role_key, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, email, displayName, `google:${payload.sub ?? 'unknown'}`, role, now(), now());
      });
      audit({
        actorId: id,
        actorName: displayName,
        action: 'auth.signup',
        entityType: 'user',
        entityId: id,
        summary: `${displayName} signed up with Google as ${(ROLES as any)[role].name}`,
        after: { email, role, provider: 'google' },
      });
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id);
    const token = createSession(row.id, req.ip, req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(1000 * 60 * 60 * 24 * 14));
    audit({
      actorId: row.id,
      actorName: row.name,
      action: 'auth.login',
      entityType: 'user',
      entityId: row.id,
      summary: `${row.name} signed in with Google`,
      meta: { provider: 'google', ip: req.ip },
    });
    res.json({ user: publicUser(row) });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const token = (req.cookies as any)?.[SESSION_COOKIE];
    const user = currentUserOrNull(req);
    destroySession(token);
    // Clearing a cookie requires matching attributes — a cross-site cookie
    // set with SameSite=None; Secure will not be removed by a Lax clear.
    const opts = sessionCookieOptions(0);
    res.clearCookie(SESSION_COOKIE, {
      path: opts.path,
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      secure: opts.secure,
    });
    if (user) {
      audit({
        actorId: user.id,
        actorName: user.name,
        action: 'auth.logout',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.name} signed out`,
      });
    }
    res.json({ ok: true });
  }),
);

function currentUserOrNull(req: any) {
  return req.user ?? null;
}

authRouter.get(
  '/me',
  ah(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in required.' } });
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) as any;
    if (!row) return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in required.' } });
    res.json({
      user: publicUser(row),
      permissionCatalog: PERMISSIONS,
      roleCatalog: ROLES,
    });
  }),
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

authRouter.post(
  '/password',
  requireAuth,
  ah(async (req, res) => {
    const user = currentUser(req);
    const { currentPassword, newPassword } = parseBody(passwordSchema, req.body);
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as any;
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw badRequest('Your current password is incorrect.');
    }
    const hash = await hashPassword(newPassword);
    getDb().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), user.id);
    audit({
      actorId: user.id,
      actorName: user.name,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.name} changed their password`,
    });
    res.json({ ok: true });
  }),
);

/** Roster used for assignment pickers. Respects basic auth so it is not public. */
authRouter.get(
  '/roster',
  requireAuth,
  ah(async (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT id, name, email, role_key, active FROM users
          WHERE active = 1 ORDER BY name COLLATE NOCASE`,
      )
      .all();
    res.json({ rows });
  }),
);

authRouter.post(
  '/users',
  requirePermission('admin.manage'),
  ah(async (req, res) => {
    const schema = z.object({
      email: z.string().trim().email().max(200),
      name: z.string().trim().min(1).max(120),
      role: z.string().refine((r) => r in ROLES, 'Unknown role'),
      password: z.string().min(8).max(200),
    });
    const input = parseBody(schema, req.body);
    const actor = currentUser(req);
    const exists = getDb().prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(input.email);
    if (exists) throw badRequest('A user with that email already exists.');

    const hash = await hashPassword(input.password);
    const id = newId('usr');
    tx((db) => {
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, role_key, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, input.email.toLowerCase(), input.name, hash, input.role, now(), now());
    });
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'user.created',
      entityType: 'user',
      entityId: id,
      summary: `Created ${input.name} as ${(ROLES as any)[input.role].name}`,
      after: { email: input.email, role: input.role },
    });
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    res.status(201).json({ user: publicUser(row) });
  }),
);

authRouter.get(
  '/users/:id',
  requirePermission('admin.manage'),
  ah(async (req, res) => {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!row) throw notFound('User not found.');
    res.json({ user: publicUser(row) });
  }),
);

authRouter.patch(
  '/users/:id',
  requirePermission('admin.manage'),
  ah(async (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.string().refine((r) => r in ROLES, 'Unknown role').optional(),
      active: z.boolean().optional(),
      password: z.string().min(8).max(200).optional(),
    });
    const input = parseBody(schema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('User not found.');

    if (input.active === false && before.id === actor.id) {
      throw badRequest('You cannot deactivate your own account.');
    }

    const hash = input.password ? await hashPassword(input.password) : null;
    db.prepare(
      `UPDATE users SET
         name = COALESCE(?, name),
         role_key = COALESCE(?, role_key),
         active = COALESCE(?, active),
         password_hash = COALESCE(?, password_hash),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? null,
      input.role ?? null,
      input.active === undefined ? null : input.active ? 1 : 0,
      hash,
      now(),
      req.params.id,
    );
    const after = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'user.updated',
      entityType: 'user',
      entityId: req.params.id,
      summary: `Updated ${before.name}`,
      before: { name: before.name, role: before.role_key, active: before.active },
      after: { name: after.name, role: after.role_key, active: after.active },
    });
    res.json({ user: publicUser(after) });
  }),
);
