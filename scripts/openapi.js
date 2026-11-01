"use strict";

/**
 * يولّد docs/openapi.json من المسارات المسجلة نفسها (npm run openapi)، أو يتحقق أنه محدّث
 * (npm run openapi:check، يستخدمه CI): أي تغيير في schema أو مسار دون إعادة توليد الملف يفشل الفحص.
 *
 * يبني تطبيقاً بكل الوحدات والإضافات المدمجة دون أن يتصل بالقاعدة (المجموعة لا تتصل إلا عند أول استعلام).
 */

const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const maa = require("../dist/index");

const target = join(__dirname, "..", "docs", "openapi.json");
const app = maa.createCommerceApp({
  databaseUrl: "postgresql://openapi@localhost/unused",
  ownerApiKey: "x".repeat(32),
  authTokenSecret: "y".repeat(32),
  logger: new maa.Logger("error"),
  workers: false,
  plugins: [
    maa.cityRateShipping({ rates: { Tripoli: 10000 } }),
    maa.flatRateShipping({ rate: 10000 }),
    maa.cashOnDelivery(),
    maa.coupons(),
    maa.percentageTax({ ratePercent: 10 }),
  ],
});
const json = `${JSON.stringify(app.openapi(), null, 2)}\n`;

app.pool.end().then(() => {
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== json) {
      console.error("docs/openapi.json is out of date. Run: npm run build && npm run openapi");
      process.exitCode = 1;
      return;
    }
    console.log("docs/openapi.json is up to date");
    return;
  }
  writeFileSync(target, json);
  const count = Object.values(app.openapi().paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
  console.log(`Wrote docs/openapi.json (${count} operations)`);
});
