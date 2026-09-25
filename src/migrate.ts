import "dotenv/config";
import { createPool } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { coreModules, collectMigrations } from "./modules";

/** `npm run migrate` - creates/updates the tables of every built-in module in DATABASE_URL. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const pool = createPool(url);
  try {
    const applied = await runMigrations(pool, collectMigrations(coreModules), (m) => console.log(m));
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "Database is already up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
