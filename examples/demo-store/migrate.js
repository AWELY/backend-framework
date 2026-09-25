const { buildApp } = require("./app");

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
