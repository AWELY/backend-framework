import { Pool, type PoolConfig } from "pg";

/**
 * Creates a connection pool for the single configured PostgreSQL database.
 * Nothing else in the framework opens its own connection - every repository
 * receives this same Pool, which is the "single storage system" rule made concrete.
 */
export function createPool(connectionString: string, options: Partial<PoolConfig> = {}): Pool {
  return new Pool({ connectionString, ...options });
}

/** Cheap connectivity check, e.g. for a startup/health check. */
export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
