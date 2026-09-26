"use strict";

/**
 * `npm run setup -- --db-password <password>` - creates storefront/.env from
 * .env.example with random secrets and the ama_store database URL.
 * Never overwrites an existing .env.
 */

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");

const target = join(__dirname, ".env");
const { values } = parseArgs({ options: { "db-password": { type: "string" } } });

if (existsSync(target)) {
  console.log("storefront/.env already exists - leaving it untouched.");
  process.exit(0);
}

let env = readFileSync(join(__dirname, ".env.example"), "utf8")
  .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
  .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);

if (values["db-password"]) {
  const password = encodeURIComponent(values["db-password"]);
  env = env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgresql://commerce_app:${password}@localhost:5432/ama_store`);
}

writeFileSync(target, env);
console.log("Created storefront/.env with random secrets.");
if (!values["db-password"]) console.log("Now set DATABASE_URL in storefront/.env.");
