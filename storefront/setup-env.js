"use strict";

/**
 * الأمر:  npm run setup -- --db-password <كلمة السر>
 * ينشئ storefront/.env من .env.example، بأسرار عشوائية جديدة، ورابط قاعدة ama_store.
 * لا يكتب فوق .env موجود أبداً، حتى لا تضيع إعداداتك أو تتغير أسرارك
 * (تغيير سر التوكن يُخرج كل الزبائن من حساباتهم).
 *
 * لاحظ "--" في الأمر: تخبر npm أن ما بعدها معاملات للسكربت نفسه، لا لـ npm.
 */

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");

const target = join(__dirname, ".env");
// parseArgs مدمجة في Node: تقرأ --db-password <قيمة> من سطر الأوامر.
const { values } = parseArgs({ options: { "db-password": { type: "string" } } });

if (existsSync(target)) {
  console.log("storefront/.env already exists - leaving it untouched.");
  process.exit(0);
}

// نسخة من القالب، مع سرين عشوائيين جديدين (32 بايتاً لكل منهما، أي 64 حرفاً سداسياً).
let env = readFileSync(join(__dirname, ".env.example"), "utf8")
  .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
  .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);

if (values["db-password"]) {
  // encodeURIComponent: كلمة السر داخل رابط، فالرموز مثل @ و : يجب ترميزها وإلا أفسدت الرابط.
  const password = encodeURIComponent(values["db-password"]);
  env = env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgresql://commerce_app:${password}@localhost:5432/ama_store`);
}

writeFileSync(target, env);
console.log("Created storefront/.env with random secrets.");
if (!values["db-password"]) console.log("Now set DATABASE_URL in storefront/.env.");
