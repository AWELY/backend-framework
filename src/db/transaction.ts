import type { Pool, PoolClient } from "pg";

/**
 * Runs `work` inside one database transaction on a single connection: COMMIT if
 * it resolves, ROLLBACK if it throws. Used where several writes must succeed or
 * fail together (e.g. creating an order and decrementing stock).
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
