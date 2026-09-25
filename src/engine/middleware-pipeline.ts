import type { AppRequest } from "./http/request";
import type { AppResponse } from "./http/response";
import type { Handler, NextFunction } from "./router";

/**
 * Runs a list of handlers in order, Express-style: each one calls next() to move
 * on, or next(err) to jump straight to onError. Handlers can be sync or return a
 * Promise - either way, a thrown/rejected error is caught and routed to onError
 * instead of crashing the process.
 */
export function runPipeline(
  handlers: Handler[],
  req: AppRequest,
  res: AppResponse,
  onError: (err: unknown) => void
): void {
  let index = 0;

  const next: NextFunction = (err?: unknown) => {
    if (err !== undefined) {
      onError(err);
      return;
    }
    const handler = handlers[index++];
    if (!handler) return;
    try {
      const result = handler(req, res, next);
      if (result instanceof Promise) {
        result.catch(onError);
      }
    } catch (syncErr) {
      onError(syncErr);
    }
  };

  next();
}
