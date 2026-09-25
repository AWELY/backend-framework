/**
 * Centralized error types. Every error the framework or an application built on it
 * wants to turn into a specific HTTP response should extend AppError.
 *
 * `toErrorResponse` is the single place that decides how an error becomes an HTTP
 * response body. It lives here (in the engine), not in middleware/, because the
 * server itself needs it for cases middleware never sees (an unmatched route, a
 * malformed JSON body) - see engine/http/server.ts.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;
  /** Extra response headers, e.g. Retry-After on 429. */
  headers?: Record<string, string>;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(message, 409, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429, { retryAfterSeconds });
    this.headers = { "Retry-After": String(retryAfterSeconds) };
  }
}

export interface ErrorResponse {
  statusCode: number;
  body: { error: { message: string; details: unknown } };
  headers?: Record<string, string>;
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: { error: { message: err.message, details: err.details ?? null } },
      headers: err.headers,
    };
  }
  return {
    statusCode: 500,
    body: { error: { message: "Internal server error", details: null } },
  };
}
