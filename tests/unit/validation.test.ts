import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, ValidationError, type Schema } from "../../src/index";

const schema = {
  name: { type: "string", minLength: 2 },
  price: { type: "number", integer: true, min: 0 },
  note: { type: "string", optional: true },
} as const satisfies Schema;

function issuesOf(fn: () => unknown): Array<{ field: string; message: string }> {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    return err.details as Array<{ field: string; message: string }>;
  }
  assert.fail("expected a ValidationError");
}

test("valid input passes and only schema fields are returned", () => {
  assert.deepEqual(validate(schema, { name: "Mug", price: 10 }), { name: "Mug", price: 10 });
});

test("missing required fields are all reported at once", () => {
  const issues = issuesOf(() => validate(schema, {}));
  assert.deepEqual(issues.map((i) => i.field).sort(), ["name", "price"]);
});

test("unknown fields are rejected (mass-assignment protection)", () => {
  const issues = issuesOf(() => validate(schema, { name: "Mug", price: 1, role: "owner" }));
  assert.deepEqual(issues, [{ field: "role", message: "is not an allowed field" }]);
});

test("type and constraint violations", () => {
  const issues = issuesOf(() => validate(schema, { name: "M", price: 1.5 }));
  assert.equal(issues.length, 2);
});

test("partial mode (PATCH) makes every field optional", () => {
  assert.deepEqual(validate(schema, { price: 3 }, { partial: true }), { price: 3 });
});

test("non-object bodies are rejected", () => {
  assert.throws(() => validate(schema, [1, 2]), ValidationError);
  assert.throws(() => validate(schema, "text"), ValidationError);
});
