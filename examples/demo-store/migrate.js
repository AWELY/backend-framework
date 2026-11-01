const { buildApp } = require("./app");

// npm run migrate: ينشئ جداول المتجر التجريبي أو يحدّثها، دون تشغيل الخادم.
// تشغيله مرة ثانية آمن: يرد "Database is already up to date".
async function main() {
  const { app } = buildApp("info");
  try {
    const applied = await app.migrate();
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "Database is already up to date.");
  } finally {
    // نغلق اتصالات القاعدة، وإلا بقي البرنامج يعمل ولم ينتهِ.
    await app.pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
