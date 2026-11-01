"use strict";

/**
 * الأمر npm run setup: ينشئ ملف .env من .env.example لنسخة جديدة من المشروع (بعد git clone)،
 * والسران (OWNER_API_KEY و AUTH_TOKEN_SECRET) مملوءان مسبقاً بقيم عشوائية.
 * لا يكتب فوق .env موجود أبداً.
 *
 * اختياري: مرّر كلمة سر مستخدم القاعدة commerce_app، فيملأ رابطي القاعدتين معاً
 * (قاعدة التطوير commerce_dev، وقاعدة الاختبار commerce_test):
 *   npm run setup -- --db-password <كلمة السر>
 */

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");

// مجلد المشروع: المجلد الأعلى من scripts.
const root = join(__dirname, "..");
const target = join(root, ".env");
// parseArgs مدمجة في Node: تقرأ --db-password <قيمة> من سطر الأوامر.
const { values } = parseArgs({ options: { "db-password": { type: "string" } } });

if (existsSync(target)) {
  console.log(".env already exists - leaving it untouched.");
  process.exit(0);
}

// نسخة من القالب، مع سرين عشوائيين جديدين (32 بايتاً، أي 64 حرفاً سداسياً لكل منهما).
let env = readFileSync(join(root, ".env.example"), "utf8")
  .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
  .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);

const password = values["db-password"];
if (password) {
  // encodeURIComponent: كلمة السر داخل رابط، فرموز مثل @ و : يجب ترميزها وإلا أفسدت الرابط.
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
