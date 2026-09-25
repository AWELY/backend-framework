import { AppError, ConflictError, ValidationError } from "../engine/errors";

/**
 * Turns PostgreSQL error codes that are really the CLIENT's mistake into the
 * matching HTTP error, instead of letting them surface as a 500. The database
 * enforces these rules anyway (unique slugs, existing categories, non-negative
 * stock); this only decides how the violation is reported.
 *
 * Postgres' own `detail` text is deliberately not forwarded - it can echo
 * stored values back to the caller.
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const { code, constraint } = err as { code?: string; constraint?: string };
  switch (code) {
    case "23505": // unique_violation
      return new ConflictError("A record with the same unique value already exists", { constraint });
    case "23503": // foreign_key_violation
      return new ValidationError("A referenced record does not exist", { constraint });
    case "23514": // check_violation
      return new ValidationError("A value violates a database rule", { constraint });
    case "22P02": // invalid_text_representation (e.g. malformed UUID)
      return new ValidationError("A value has an invalid format");
    default:
      return err;
  }
}
