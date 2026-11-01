import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, validateQuery, ValidationError, type Schema } from "../../src/index";

/** يرجع details خطأ التحقق، أو يفشل الاختبار إن لم يُرمَ ValidationError. */
function issuesOf(fn: () => unknown): Array<{ field: string; message: string }> {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    return (err.details as Array<{ field: string; message: string }>) ?? [];
  }
  assert.fail("expected a ValidationError");
}

const refund = {
  amount: { type: "number", integer: true, min: 1 },
  restock: {
    type: "array",
    optional: true,
    maxItems: 3,
    items: { type: "object", properties: { productId: { type: "string" }, quantity: { type: "number", integer: true, min: 1 } } },
  },
} as const satisfies Schema;

test("nested objects and arrays are validated, with full paths in errors", () => {
  assert.deepEqual(validate(refund, { amount: 5, restock: [{ productId: "a", quantity: 2 }] }), {
    amount: 5,
    restock: [{ productId: "a", quantity: 2 }],
  });
  const issues = issuesOf(() => validate(refund, { amount: 0, restock: [{ productId: "a", quantity: 0, extra: true }, "x"] }));
  assert.deepEqual(
    issues.map((i) => i.field).sort(),
    ["amount", "restock[0].extra", "restock[0].quantity", "restock[1]"].sort()
  );
  assert.ok(issuesOf(() => validate(refund, { amount: 1, restock: [{}, {}, {}, {}] })).some((i) => /at most 3/.test(i.message)));
});

test("nullable fields accept null as a value; non-nullable null still means 'not sent'", () => {
  const schema = {
    categoryId: { type: "string", optional: true, nullable: true },
    name: { type: "string", optional: true },
  } as const satisfies Schema;
  assert.deepEqual(validate(schema, { categoryId: null, name: null }), { categoryId: null });
  assert.deepEqual(validate(schema, { categoryId: null }, { partial: true }), { categoryId: null });
  // مطلوب وغير nullable: null خطأ "is required"
  assert.equal(issuesOf(() => validate({ name: { type: "string" } }, { name: null }))[0]?.message, "is required");
});

test("inherited property names are not mistaken for schema fields (constructor, __proto__)", () => {
  const issues = issuesOf(() => validate({ name: { type: "string" } }, JSON.parse('{"name":"x","constructor":1,"__proto__":{"a":1}}')));
  assert.deepEqual(issues.map((i) => i.field).sort(), ["__proto__", "constructor"]);
});

test("oneOf, integer safety and string limits", () => {
  const schema = { status: { type: "string", oneOf: ["a", "b"] }, n: { type: "number", integer: true } } as const satisfies Schema;
  assert.match(issuesOf(() => validate(schema, { status: "c", n: 1 }))[0]?.message ?? "", /one of: a, b/);
  assert.ok(issuesOf(() => validate(schema, { status: "a", n: 2 ** 60 })).some((i) => i.message === "must be an integer"));
});

test("query validation coerces strings, reads repeated keys, and ignores unknown keys", () => {
  const schema = {
    limit: { type: "number", integer: true, min: 1, max: 100, optional: true },
    active: { type: "boolean", optional: true },
    tag: { type: "array", items: { type: "string" }, optional: true },
  } as const satisfies Schema;
  assert.deepEqual(validateQuery(schema, new URLSearchParams("limit=20&active=true&tag=a&tag=b&utm_source=x")), {
    limit: 20,
    active: true,
    tag: ["a", "b"],
  });
  assert.equal(issuesOf(() => validateQuery(schema, new URLSearchParams("limit=abc")))[0]?.message, "must be a number");
  assert.equal(issuesOf(() => validateQuery(schema, new URLSearchParams("limit=1000")))[0]?.message, "must be <= 100");
  assert.deepEqual(validateQuery(schema, new URLSearchParams("limit=")), {});
});

test("fuzz: any JSON value either validates or throws ValidationError, never anything else", () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const values = (depth: number): unknown => {
    const r = random();
    if (depth > 3 || r < 0.2) return [null, true, 0, -1, 1.5, "", "x".repeat(Math.floor(random() * 20)), 2 ** 60][Math.floor(random() * 8)];
    if (r < 0.6) {
      const obj: Record<string, unknown> = {};
      for (const key of ["amount", "restock", "productId", "quantity", "constructor", "zzz"]) if (random() < 0.5) obj[key] = values(depth + 1);
      return obj;
    }
    return Array.from({ length: Math.floor(random() * 5) }, () => values(depth + 1));
  };
  for (let i = 0; i < 3000; i++) {
    const input = values(0);
    try {
      validate(refund, input);
    } catch (err) {
      assert.ok(err instanceof ValidationError, `input ${JSON.stringify(input)} threw ${String(err)}`);
    }
  }
});
