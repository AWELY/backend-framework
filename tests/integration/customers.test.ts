// اختبارات تكامل لحسابات الزبائن: التسجيل، والدخول، والملف الشخصي، والصلاحيات.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

// البريد بحروف كبيرة عمداً، لنختبر أنه يُوحَّد إلى حروف صغيرة.
const account = { email: "Sara@Example.com", password: "a-long-password", name: "Sara", phone: "+218 91 234 5678" };

// التسجيل يرجع الزبون وتوكناً، ولا يرجع الـ hash أبداً (بأي اسم). وفي القاعدة نفسها: hash بصيغة scrypt.
test("register returns the customer (never the password hash) and a token", async () => {
  const res = await api(t.base, "POST", "/customers/register", { body: account });
  assert.equal(res.status, 201);
  assert.equal(res.body.customer.email, "sara@example.com");
  assert.equal(res.body.customer.passwordHash, undefined);
  assert.equal(res.body.customer.password_hash, undefined);
  assert.equal(typeof res.body.token, "string");

  const { rows } = await t.app.pool.query("SELECT password_hash FROM customers WHERE email = 'sara@example.com'");
  assert.ok(rows[0].password_hash.startsWith("scrypt$"));
});

// نفس البريد بحالة حروف مختلفة: مرفوض (409)، بفضل الفهرس الفريد على lower(email).
test("email is unique regardless of case", async () => {
  const dup = await api(t.base, "POST", "/customers/register", { body: { ...account, email: "SARA@example.COM" } });
  assert.equal(dup.status, 409);
});

// بريد خاطئ، وكلمة مرور قصيرة، واسم فارغ: 400 مع الحقول الثلاثة معاً.
test("weak input is rejected", async () => {
  const res = await api(t.base, "POST", "/customers/register", {
    body: { email: "not-an-email", password: "short", name: "" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.map((d: { field: string }) => d.field).sort(), ["email", "name", "password"]);
});

// كلمة المرور الصحيحة تعطي توكناً. والخاطئة والبريد غير المسجل يعطيان نفس الرد 401 حرفياً،
// فلا يعرف المهاجم أي البريدات مسجلة.
test("login: right password works; wrong password and unknown email give the SAME 401", async () => {
  const ok = await api(t.base, "POST", "/customers/login", { body: { email: "sara@example.com", password: account.password } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, "string");

  const wrongPw = await api(t.base, "POST", "/customers/login", { body: { email: "sara@example.com", password: "nope-nope" } });
  const noUser = await api(t.base, "POST", "/customers/login", { body: { email: "nobody@example.com", password: "nope-nope" } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  // نفس الرد بالضبط، ما عدا requestId (رقم كل طلب مختلف بطبيعته).
  const withoutRequestId = (body: { error: Record<string, unknown> }) => ({ ...body.error, requestId: undefined });
  assert.deepEqual(withoutRequestId(wrongPw.body), withoutRequestId(noUser.body));
  assert.equal(wrongPw.body.error.code, "INVALID_CREDENTIALS");
});

// /customers/me: بلا توكن 401، وتوكن معدّل (حرف زائد) 401، وبالتوكن الصحيح يرى ملفه.
// تعديل الاسم مسموح، وتعديل البريد مرفوض (ليس في profileSchema). وقائمة الزبائن للمالك فقط (الزبون 403).
test("/customers/me with a token; profile update; owner-only customer list", async () => {
  const { body } = await api(t.base, "POST", "/customers/login", { body: { email: "sara@example.com", password: account.password } });
  const token = body.token as string;

  assert.equal((await api(t.base, "GET", "/customers/me")).status, 401);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: token + "x" })).status, 401);

  const me = await api(t.base, "GET", "/customers/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.name, "Sara");

  const updated = await api(t.base, "PATCH", "/customers/me", { token, body: { name: "Sara A." } });
  assert.equal(updated.body.name, "Sara A.");
  // لا يمكن تغيير البريد، ولا دسّ حقول أخرى، عبر مسار الملف الشخصي.
  assert.equal((await api(t.base, "PATCH", "/customers/me", { token, body: { email: "x@y.z" } })).status, 400);

  assert.equal((await api(t.base, "GET", "/customers", { token })).status, 403);
  const list = await api(t.base, "GET", "/customers", { owner: true });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});
