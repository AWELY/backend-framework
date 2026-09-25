import type { Pool } from "pg";

/**
 * Minimal migration runner - no migration tool dependency. Each module ships its
 * schema as ordered Migration objects (plain SQL in TypeScript, so it is compiled
 * into dist/ with no extra files to copy). Applied ids are recorded in
 * schema_migrations, so running this again only applies what is new.
 */

export interface Migration {
  /** Globally ordered id, e.g. "0100_categories". Sorted as strings. */
  id: string;
  up: string;
}

// Arbitrary constant: a Postgres advisory lock so two processes starting at
// once cannot apply the same migration twice.
const MIGRATION_LOCK_KEY = 727_274;

export async function runMigrations(
  pool: Pool,
  migrations: Migration[],
  log: (message: string) => void = () => undefined
): Promise<string[]> {
  const sorted = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const m of sorted) {
    if (ids.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
    ids.add(m.id);
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const done = new Set(rows.map((r) => r.id));

    const applied: string[] = [];
    for (const migration of sorted) {
      if (done.has(migration.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.up);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`);
      }
      applied.push(migration.id);
      log(`Applied migration ${migration.id}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
