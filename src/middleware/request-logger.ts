import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { Logger } from "../engine/logger";

/** Logs "METHOD path status duration" once the response finishes. */
export function requestLogger(logger: Logger) {
  return function requestLoggerMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    const start = Date.now();
    res.on("finish", () => {
      logger.info(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  };
}
