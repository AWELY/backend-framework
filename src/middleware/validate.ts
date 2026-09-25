import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import { validate, type Schema } from "../engine/validation";

/**
 * Route-level middleware: validates req.body against `schema` and replaces it
 * with the cleaned result (unknown fields removed), or passes a ValidationError
 * to the error handler, which answers 400 with the list of field problems.
 */
export function validateBody(schema: Schema, options: { partial?: boolean } = {}) {
  return function validateBodyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    try {
      req.body = options.partial ? validate(schema, req.body, { partial: true }) : validate(schema, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}
