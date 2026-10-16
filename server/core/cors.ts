import type { Request, RequestHandler, Response, NextFunction } from 'express';

/**
 * Cross-origin support for the split deployment.
 *
 * Firebase Hosting serves the static SPA. The Spark (free) plan cannot run
 * Cloud Functions or Cloud Run, so the Express API runs on a different
 * origin. That makes every request cross-origin, which needs an explicit
 * allow-list plus credentialed cookie support — a wildcard origin cannot be
 * combined with credentials, so the origins are configured, never defaulted
 * to `*`.
 *
 * Set `CORS_ORIGINS` to a comma-separated list of exact origins, e.g.
 *   CORS_ORIGINS=https://quest-lite.web.app,http://localhost:5173
 *
 * When unset, no CORS headers are emitted and the same-origin path is used
 * (dev server proxy, or hosting the API and SPA together).
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function configuredOrigins(): string[] {
  return parseOrigins(process.env.CORS_ORIGINS);
}

function isAllowed(origin: string, allow: string[], allowLocal: boolean): boolean {
  const cleaned = origin.replace(/\/+$/, '');
  if (allow.includes(cleaned)) return true;
  if (!allowLocal) return false;
  // Local development convenience: any loopback port is accepted so the Vite
  // dev server works without editing env vars on every machine.
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(cleaned);
}

export function cors(): RequestHandler {
  const allow = configuredOrigins();
  const allowLocal = process.env.CORS_ALLOW_LOCALHOST !== 'false';

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');

    // Only listed origins are echoed back. A wildcard origin cannot be
    // combined with credentials, so an unlisted origin simply gets no CORS
    // headers and its request is blocked by the browser. Note the localhost
    // escape hatch is an ALTERNATIVE to the list, never a bypass of it — an
    // origin that is neither listed nor loopback must be refused.
    if (origin && isAllowed(origin, allow, allowLocal)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, X-Requested-With',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    // Preflight never needs to reach a route handler.
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Cookie attributes for the session token.
 *
 * A cross-site deployment requires `SameSite=None; Secure`, otherwise the
 * browser drops the cookie and every request looks signed out. Same-origin
 * deployments keep `Lax`, which is the safer default and works over plain
 * http:// on localhost.
 */
export function sessionCookieOptions(maxAgeMs: number): {
  httpOnly: boolean;
  sameSite: 'lax' | 'none';
  secure: boolean;
  maxAge: number;
  path: string;
} {
  const crossSite = configuredOrigins().length > 0;
  const secure = process.env.NODE_ENV === 'production' || crossSite;
  return {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure,
    maxAge: maxAgeMs,
    path: '/',
  };
}
