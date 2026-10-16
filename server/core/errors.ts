/**
 * Application error type. Every route failure throws HttpError so the
 * error middleware produces one consistent, safe JSON shape and never
 * leaks stack traces or SQL to the client.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, msg, 'bad_request', details);

export const unauthorized = (msg = 'Sign in required.') =>
  new HttpError(401, msg, 'unauthorized');

export const forbidden = (msg = 'You do not have permission to do that.') =>
  new HttpError(403, msg, 'forbidden');

export const notFound = (msg = 'Record not found.') =>
  new HttpError(404, msg, 'not_found');

export const conflict = (msg: string, details?: unknown) =>
  new HttpError(409, msg, 'conflict', details);

export const validationError = (msg: string, details?: unknown) =>
  new HttpError(422, msg, 'validation', details);
