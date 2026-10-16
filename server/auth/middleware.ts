import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { resolveSession, SESSION_COOKIE, newRequestId } from './session.js';
import { can, type PermissionKey } from '../core/permissions.js';
import { forbidden, unauthorized } from '../core/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  active: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
      startedAt?: number;
    }
  }
}

/** Resolves the session cookie into req.user, or leaves it undefined. */
export function attachUser(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.requestId = newRequestId();
    req.startedAt = Date.now();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const user = resolveSession(token);
    if (user) req.user = user;
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

/**
 * Server-side permission gate. This — not the UI — is the control.
 * Every mutating route and every financially sensitive read passes through it.
 */
export function requirePermission(permission: PermissionKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, permission)) {
      return next(
        forbidden(
          `Your role (${req.user.role}) does not include "${permission}".`,
        ),
      );
    }
    next();
  };
}

/** True when the signed-in user holds the permission. Used inside services. */
export function userCan(req: Request, permission: PermissionKey): boolean {
  return can(req.user?.role, permission);
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/* ------------------------------------------------------------------ */
/* Simple per-IP + per-user rate limiting (in-memory, resets on boot). */
/* ------------------------------------------------------------------ */

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}): RequestHandler {
  const { windowMs, max } = opts;
  const keyFn =
    opts.key ?? ((req: Request) => `${req.ip ?? 'anon'}:${req.user?.id ?? 'anon'}`);
  return (req, res, next) => {
    const key = keyFn(req);
    const nowMs = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      bucket = { count: 0, resetAt: nowMs + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - nowMs) / 1000)));
      return next(
        Object.assign(new Error('Too many requests. Please slow down.'), {
          status: 429,
          code: 'rate_limited',
        }),
      );
    }
    next();
  };
}

export function clearRateLimits(): void {
  buckets.clear();
}
