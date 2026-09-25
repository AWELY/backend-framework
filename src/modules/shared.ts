import { NotFoundError } from "../engine/errors";
import type { ListOptions } from "../db/repository";

/** ?limit=&offset= with safe bounds, so a client cannot ask for a million rows. */
export function parsePagination(query: URLSearchParams): Required<ListOptions> {
  const limit = Number(query.get("limit") ?? 50);
  const offset = Number(query.get("offset") ?? 0);
  return {
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50,
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  };
}

/** Returns the entity or throws a 404 naming what was missing. */
export function found<T>(entity: T | null, what: string): T {
  if (entity === null) throw new NotFoundError(`${what} not found`);
  return entity;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
