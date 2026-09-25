import { ValidationError } from "./errors";

/**
 * Small schema validator for request payloads - no validation library, same
 * reasoning as the router and DI container: this project's needs (typed scalar
 * fields with a few constraints) are small enough that a dependency is not justified.
 *
 * Fields are REQUIRED unless marked `optional: true`. Unknown fields are
 * rejected, so a client cannot slip in fields the schema did not allow
 * (e.g. `role` or `price` on an endpoint that should not accept them).
 */

export type FieldRule =
  | {
      type: "string";
      optional?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
      oneOf?: readonly string[];
    }
  | { type: "number"; optional?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; optional?: boolean };

export type Schema = Record<string, FieldRule>;

type FieldValue<R extends FieldRule> = R extends { type: "string" }
  ? string
  : R extends { type: "number" }
    ? number
    : boolean;

type RequiredKeys<S extends Schema> = { [K in keyof S]: S[K] extends { optional: true } ? never : K }[keyof S];
type OptionalKeys<S extends Schema> = Exclude<keyof S, RequiredKeys<S>>;

/** The TypeScript type a schema produces, e.g. { name: string; stock?: number }. */
export type Infer<S extends Schema> = { [K in RequiredKeys<S>]: FieldValue<S[K]> } & {
  [K in OptionalKeys<S>]?: FieldValue<S[K]>;
};

export interface FieldIssue {
  field: string;
  message: string;
}

function checkField(field: string, rule: FieldRule, value: unknown): string | null {
  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") return "must be a string";
      if (rule.minLength !== undefined && value.length < rule.minLength)
        return `must be at least ${rule.minLength} characters`;
      if (rule.maxLength !== undefined && value.length > rule.maxLength)
        return `must be at most ${rule.maxLength} characters`;
      if (rule.pattern && !rule.pattern.test(value)) return "has an invalid format";
      if (rule.oneOf && !rule.oneOf.includes(value)) return `must be one of: ${rule.oneOf.join(", ")}`;
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (rule.integer && !Number.isInteger(value)) return "must be an integer";
      if (rule.min !== undefined && value < rule.min) return `must be >= ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `must be <= ${rule.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
  }
  return `unsupported rule for ${field}`;
}

/**
 * Validates `input` against `schema` and returns ONLY the schema's fields.
 * With `partial: true` every field becomes optional - used for PATCH updates.
 * Throws ValidationError (HTTP 400) listing every problem, not just the first.
 */
export function validate<S extends Schema>(schema: S, input: unknown, options: { partial: true }): Partial<Infer<S>>;
export function validate<S extends Schema>(schema: S, input: unknown, options?: { partial?: false }): Infer<S>;
export function validate<S extends Schema>(
  schema: S,
  input: unknown,
  options: { partial?: boolean } = {}
): Infer<S> | Partial<Infer<S>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const data = input as Record<string, unknown>;
  const issues: FieldIssue[] = [];
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(data)) {
    if (!(key in schema)) issues.push({ field: key, message: "is not an allowed field" });
  }

  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    if (value === undefined || value === null) {
      if (!rule.optional && !options.partial) issues.push({ field, message: "is required" });
      continue;
    }
    const problem = checkField(field, rule, value);
    if (problem) issues.push({ field, message: problem });
    else output[field] = value;
  }

  if (issues.length > 0) throw new ValidationError("Validation failed", issues);
  return output as Infer<S>;
}
