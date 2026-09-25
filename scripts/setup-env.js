"use strict";

/**
 * `npm run setup` - creates .env from .env.example for a fresh clone, with the
 * two secrets (OWNER_API_KEY, AUTH_TOKEN_SECRET) already filled with random
 * values. Never overwrites an existing .env.
 *
 * Optional: pass the commerce_app database password to fill both database URLs:
 *   npm run setup -- --db-password <password>
 */

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");

const root = join(__dirname, "..");
const target = join(root, ".env");
const { values } = parseArgs({ options: { "db-password": { type: "string" } } });

if (existsSync(target)) {
  console.log(".env already exists - leaving it untouched.");
  process.exit(0);
}

let env = readFileSync(join(root, ".env.example"), "utf8")
  .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
  .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);

const password = values["db-password"];
if (password) {
  const user = `commerce_app:${encodeURIComponent(password)}`;
  env = env
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgresql://${user}@localhost:5432/commerce_dev`)
    .replace(/^TEST_DATABASE_URL=.*$/m, `TEST_DATABASE_URL=postgresql://${user}@localhost:5432/commerce_test`);
}

writeFileSync(target, env);
console.log("Created .env with a random OWNER_API_KEY and AUTH_TOKEN_SECRET.");
console.log(
  password
    ? "DATABASE_URL and TEST_DATABASE_URL point to commerce_dev / commerce_test as commerce_app."
    : "Now set DATABASE_URL and TEST_DATABASE_URL in .env (see docs/SETUP.md)."
);
