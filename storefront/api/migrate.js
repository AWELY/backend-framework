const { buildApp } = require("./app");

// npm run migrate: يبني نفس التطبيق، لكن لا يستمع. يطبّق الـ migrations الناقصة فقط،
// ثم يغلق الاتصال وينتهي. تشغيله مرة ثانية آمن: يرد "Database is already up to date".
async function main() {
  const { app } = buildApp("info");
  try {
    const applied = await app.migrate();
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "Database is already up to date.");
  } finally {
    await app.pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
