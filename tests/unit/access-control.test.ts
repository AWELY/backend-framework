// اختبارات وحدة لجدول الصلاحيات (engine/access-control.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessControl } from "../../src/index";

// جدول تجريبي فيه دور إضافي "clerk" (موظف): كل عمليات الطلبات، وقراءة المنتجات فقط.
// يثبت أن إضافة دور جديد تعني سطراً في الجدول، دون تعديل أي مسار.
const ac = new AccessControl({
  owner: ["*"],
  clerk: ["orders:*", "products:read"],
  customer: ["products:read"],
});

// "*" تعطي كل صلاحية، حتى صلاحية غير موجودة أصلاً.
test("'*' grants every permission", () => {
  assert.ok(ac.can("owner", "products:write"));
  assert.ok(ac.can("owner", "anything:at-all"));
});

// "orders:*" تعطي كل عمليات الطلبات، لكن لا شيء على مورد آخر.
test("'resource:*' grants every action on that resource only", () => {
  assert.ok(ac.can("clerk", "orders:create"));
  assert.ok(ac.can("clerk", "orders:read-all"));
  assert.ok(!ac.can("clerk", "products:write"));
});

// صلاحية محددة: القراءة مسموحة، والكتابة لا.
test("exact permissions", () => {
  assert.ok(ac.can("customer", "products:read"));
  assert.ok(!ac.can("customer", "products:write"));
});

// دور غير معروف، أو زائر بلا دور: لا صلاحيات أبداً.
test("unknown role or anonymous caller gets nothing", () => {
  assert.ok(!ac.can("ghost", "products:read"));
  assert.ok(!ac.can(undefined, "products:read"));
});
