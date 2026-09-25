import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessControl } from "../../src/index";

const ac = new AccessControl({
  owner: ["*"],
  clerk: ["orders:*", "products:read"],
  customer: ["products:read"],
});

test("'*' grants every permission", () => {
  assert.ok(ac.can("owner", "products:write"));
  assert.ok(ac.can("owner", "anything:at-all"));
});

test("'resource:*' grants every action on that resource only", () => {
  assert.ok(ac.can("clerk", "orders:create"));
  assert.ok(ac.can("clerk", "orders:read-all"));
  assert.ok(!ac.can("clerk", "products:write"));
});

test("exact permissions", () => {
  assert.ok(ac.can("customer", "products:read"));
  assert.ok(!ac.can("customer", "products:write"));
});

test("unknown role or anonymous caller gets nothing", () => {
  assert.ok(!ac.can("ghost", "products:read"));
  assert.ok(!ac.can(undefined, "products:read"));
});
