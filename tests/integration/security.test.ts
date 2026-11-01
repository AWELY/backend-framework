import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  api,
  registerCustomer,
  createStaff,
  OWNER_KEY,
  TOKEN_SECRET,
  type TestApp,
} from "../helpers/test-app";
import { signToken, type CommercePlugin } from "../../src/index";

/** إضافة "بريد" وهمية: تلتقط رموز استعادة كلمة المرور كما تفعل إضافة بريد حقيقية. */
const resetMail: Array<{ email: string; token: string }> = [];
const mailer: CommercePlugin = {
  name: "test-mailer",
  setup({ extensions }) {
    extensions.on("customer.passwordResetRequested", ({ customer, token }) => {
      resetMail.push({ email: customer.email, token });
    });
  },
};

let t: TestApp;
before(async () => {
  t = await startTestApp({ plugins: [mailer], loginRateLimit: false, registrationRateLimit: false });
});
after(async () => {
  await t.close();
});

async function login(email: string, password: string) {
  return api(t.base, "POST", "/customers/login", { body: { email, password } });
}

test("logout revokes only this device; logout-all revokes every device", async () => {
  const c = await registerCustomer(t.base);
  const second = (await login(c.email, c.password)).body.token as string;
  assert.equal((await api(t.base, "GET", "/customers/me", { token: c.token })).status, 200);

  assert.equal((await api(t.base, "POST", "/customers/logout", { token: c.token })).status, 204);
  const revoked = await api(t.base, "GET", "/customers/me", { token: c.token });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error.code, "INVALID_TOKEN");
  assert.equal(revoked.body.error.message, "Invalid or expired token");
  assert.equal((await api(t.base, "GET", "/customers/me", { token: second })).status, 200);

  const third = (await login(c.email, c.password)).body.token as string;
  const sessions = await api(t.base, "GET", "/customers/me/sessions", { token: third });
  assert.equal(sessions.body.length, 2);
  assert.equal(sessions.body.filter((s: { current: boolean }) => s.current).length, 1);
  assert.equal((await api(t.base, "POST", "/customers/logout-all", { token: third })).status, 204);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: second })).status, 401);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: third })).status, 401);
});

test("a correctly signed token without a session is rejected (no stateless bypass)", async () => {
  const c = await registerCustomer(t.base);
  const forged = signToken({ sub: c.customer.id, role: "customer" }, TOKEN_SECRET, 3600);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: forged })).status, 401);
  const fakeSession = signToken({ sub: c.customer.id, role: "customer", sid: "00000000-0000-0000-0000-000000000000", pt: "customer" }, TOKEN_SECRET, 3600);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: fakeSession })).status, 401);
});

test("changing the password keeps this device and logs out the others", async () => {
  const c = await registerCustomer(t.base);
  const other = (await login(c.email, c.password)).body.token as string;
  const wrong = await api(t.base, "POST", "/customers/me/password", { token: c.token, body: { currentPassword: "nope-nope", newPassword: "brand-new-pass" } });
  assert.equal(wrong.status, 400);
  assert.equal((await api(t.base, "POST", "/customers/me/password", { token: c.token, body: { currentPassword: c.password, newPassword: "brand-new-pass" } })).status, 204);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: c.token })).status, 200);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: other })).status, 401);
  assert.equal((await login(c.email, c.password)).status, 401);
  assert.equal((await login(c.email, "brand-new-pass")).status, 200);
});

test("password reset: same 202 for any email, code delivered by event, single use, sessions revoked", async () => {
  const c = await registerCustomer(t.base);
  const unknown = await api(t.base, "POST", "/customers/password-reset", { body: { email: "nobody@example.ly" } });
  const known = await api(t.base, "POST", "/customers/password-reset", { body: { email: c.email.toUpperCase() } });
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);

  await t.app.drainBackgroundWork();
  const mail = resetMail.find((m) => m.email === c.email);
  assert.ok(mail, "the mailer plugin received the reset code");
  // الرمز لا يبقى في صندوق الصادر بعد تسليمه (حدث حساس).
  const { rows } = await t.app.pool.query(
    "SELECT payload FROM outbox_events WHERE event = 'customer.passwordResetRequested' AND processed_at IS NOT NULL"
  );
  assert.ok(rows.length > 0 && rows.every((r) => r.payload === null));

  const ok = await api(t.base, "POST", "/customers/password-reset/confirm", { body: { token: mail.token, password: "reset-password-1" } });
  assert.equal(ok.status, 200);
  assert.equal((await api(t.base, "GET", "/customers/me", { token: c.token })).status, 401, "old sessions are revoked");
  assert.equal((await login(c.email, "reset-password-1")).status, 200);
  const reuse = await api(t.base, "POST", "/customers/password-reset/confirm", { body: { token: mail.token, password: "another-one-22" } });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error.code, "INVALID_RESET_TOKEN");
});

test("staff roles: admin manages the catalogue but not staff; support cannot refund; courier sees no orders list", async () => {
  const admin = await createStaff(t.base, "admin");
  const support = await createStaff(t.base, "support");
  const courier = await createStaff(t.base, "courier");

  assert.equal((await api(t.base, "GET", "/staff/me", { token: admin.token })).body.role, "admin");
  const product = await api(t.base, "POST", "/products", { token: admin.token, body: { name: "Admin made", slug: "admin-made", price: 100 } });
  assert.equal(product.status, 201);
  assert.equal((await api(t.base, "POST", "/staff", { token: admin.token, body: { email: "x@maa.ly", password: "password-123", name: "X", role: "admin" } })).status, 403);
  assert.equal((await api(t.base, "POST", "/products", { token: support.token, body: { name: "No", slug: "no-support", price: 1 } })).status, 403);
  assert.equal((await api(t.base, "GET", "/orders", { token: support.token })).status, 200);
  assert.equal((await api(t.base, "POST", "/orders/00000000-0000-0000-0000-000000000000/refunds", { token: support.token, body: { amount: 1 } })).status, 403);
  assert.equal((await api(t.base, "GET", "/orders", { token: courier.token })).status, 403);
  const roles = await api(t.base, "GET", "/staff/roles", { token: admin.token });
  assert.deepEqual(roles.body, ["admin", "manager", "support", "courier"]);
  const badRole = await api(t.base, "POST", "/staff", { owner: true, body: { email: "y@maa.ly", password: "password-123", name: "Y", role: "owner" } });
  assert.equal(badRole.status, 400);
});

test("deactivating a staff member or changing their role takes effect immediately", async () => {
  const manager = await createStaff(t.base, "manager");
  assert.equal((await api(t.base, "GET", "/customers", { token: manager.token })).status, 200);
  await api(t.base, "PATCH", `/staff/${manager.staff.id}`, { owner: true, body: { role: "courier" } });
  assert.equal((await api(t.base, "GET", "/customers", { token: manager.token })).status, 401, "role change revokes sessions");
  const relogin = await api(t.base, "POST", "/staff/login", { body: { email: manager.email, password: "staff-password-123" } });
  assert.equal(relogin.body.staff.role, "courier");
  assert.equal((await api(t.base, "GET", "/customers", { token: relogin.body.token })).status, 403);

  await api(t.base, "PATCH", `/staff/${manager.staff.id}`, { owner: true, body: { isActive: false } });
  assert.equal((await api(t.base, "GET", "/staff/me", { token: relogin.body.token })).status, 401);
  const blocked = await api(t.base, "POST", "/staff/login", { body: { email: manager.email, password: "staff-password-123" } });
  assert.equal(blocked.status, 401);
});

test("audit log records who changed what, with secrets redacted, including failed staff logins", async () => {
  const admin = await createStaff(t.base, "admin");
  await api(t.base, "POST", "/categories", { token: admin.token, body: { name: "Audited", slug: "audited" } });
  await api(t.base, "POST", "/staff/login", { body: { email: admin.email, password: "wrong-password" } });

  const log = await api(t.base, "GET", "/audit-log?limit=100", { token: admin.token });
  assert.equal(log.status, 200);
  const created = log.body.find((e: { action: string; actorId: string }) => e.action === "POST /categories" && e.actorId === admin.staff.id);
  assert.ok(created, "the category creation is in the audit log");
  assert.equal(created.actorType, "staff");
  assert.equal(created.statusCode, 201);
  assert.match(created.requestId, /^[0-9a-f-]{36}$/);
  const staffCreation = log.body.find((e: { action: string; actorType: string }) => e.action === "POST /staff" && e.actorType === "owner");
  assert.equal(staffCreation.body.password, "[REDACTED]");
  assert.ok(log.body.some((e: { action: string }) => e.action === "staff.login_failed"));
  const support = await createStaff(t.base, "support");
  assert.equal((await api(t.base, "GET", "/audit-log", { token: support.token })).status, 403);
});

test("secret rotation: a new secret still accepts tokens and owner keys signed with the previous one", async () => {
  const c = await registerCustomer(t.base);
  const rotated = await startTestApp({
    resetDatabase: false,
    authTokenSecret: "a-brand-new-token-secret-of-32-chars-at-least",
    previousAuthTokenSecrets: [TOKEN_SECRET],
    ownerApiKey: "a-brand-new-owner-key-0000000000000000",
    previousOwnerApiKeys: [OWNER_KEY],
  });
  try {
    assert.equal((await api(rotated.base, "GET", "/customers/me", { token: c.token })).status, 200);
    assert.equal((await api(rotated.base, "GET", "/customers", { owner: true })).status, 200);
    assert.equal((await api(rotated.base, "GET", "/customers", { headers: { "x-api-key": "a-brand-new-owner-key-0000000000000000" } })).status, 200);
    assert.equal((await api(rotated.base, "GET", "/customers", { headers: { "x-api-key": "wrong" } })).status, 401);
  } finally {
    await rotated.close();
  }
});
