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

const account = { email: "Sara@Example.com", password: "a-long-password", name: "Sara", phone: "+218 91 234 5678" };

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

test("email is unique regardless of case", async () => {
  const dup = await api(t.base, "POST", "/customers/register", { body: { ...account, email: "SARA@example.COM" } });
  assert.equal(dup.status, 409);
});

test("weak input is rejected", async () => {
  const res = await api(t.base, "POST", "/customers/register", {
    body: { email: "not-an-email", password: "short", name: "" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.map((d: { field: string }) => d.field).sort(), ["email", "name", "password"]);
});

test("login: right password works; wrong password and unknown email give the SAME 401", async () => {
  const ok = await api(t.base, "POST", "/customers/login", { body: { email: "sara@example.com", password: account.password } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, "string");

  const wrongPw = await api(t.base, "POST", "/customers/login", { body: { email: "sara@example.com", password: "nope-nope" } });
  const noUser = await api(t.base, "POST", "/customers/login", { body: { email: "nobody@example.com", password: "nope-nope" } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.deepEqual(wrongPw.body, noUser.body);
});

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
  // Cannot change email or smuggle other fields through the profile endpoint.
  assert.equal((await api(t.base, "PATCH", "/customers/me", { token, body: { email: "x@y.z" } })).status, 400);

  assert.equal((await api(t.base, "GET", "/customers", { token })).status, 403);
  const list = await api(t.base, "GET", "/customers", { owner: true });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});
