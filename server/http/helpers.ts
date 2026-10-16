import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, z, type ZodSchema } from 'zod';
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../core/errors.js';

/** Wraps an async route so rejections reach the error middleware. */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validate and coerce a request payload, producing a 422 with field detail.
 *
 * Typed with `z.output<S>` rather than `ZodSchema<T>` so `.default()` and
 * `.optional()` fields come back as their OUTPUT type (a defaulted field is
 * never `undefined` to the caller).
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  try {
    return schema.parse(data) as z.output<S>;
  } catch (err) {
    if (err instanceof ZodError) {
      throw validationError(
        'Some fields need attention.',
        err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      );
    }
    throw err;
  }
}

export function parseQuery<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  return parseBody(schema, data ?? {});
}

/** Fetch a row or throw 404 — keeps routes free of null-check noise. */
export function must<T>(row: T | undefined | null, what = 'Record'): T {
  if (row === undefined || row === null) throw notFound(`${what} not found.`);
  return row;
}

export function parsePagination(req: Request, defaultLimit = 50, maxLimit = 200) {
  const raw = Number((req.query as any)?.limit ?? defaultLimit);
  const rawOffset = Number((req.query as any)?.offset ?? 0);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), maxLimit) : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

/** Standard paginated envelope. */
export function page<T>(rows: T[], total: number, limit: number, offset: number) {
  return { rows, total, limit, offset, hasMore: offset + rows.length < total };
}

export function handleError(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  const anyErr = err as any;
  if (anyErr && anyErr.status && typeof anyErr.status === 'number') {
    return res.status(anyErr.status).json({
      error: { code: anyErr.code ?? 'error', message: anyErr.message ?? 'Request failed.' },
    });
  }
  // Never leak stack traces or SQL to the client.
  console.error('[quest-lite] unhandled error:', anyErr?.stack ?? anyErr);
  return res.status(500).json({
    error: { code: 'internal', message: 'Something went wrong on the server.' },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found.' } });
}

// Routes import their errors from one place: the helpers they already need.
export { badRequest, conflict, forbidden, notFound, validationError, HttpError };
