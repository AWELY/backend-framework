import type { QueryResult, QueryResultRow } from "pg";
import { translateDbError } from "./errors";
import { isUuid } from "./ids";

/**
 * Anything that can run a query: the shared Pool, or a single PoolClient
 * inside withTransaction(). Repositories accept either, so the same repository
 * class works inside and outside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

/**
 * Repository pattern over raw, parameterized SQL (no ORM). A subclass supplies
 * its table, how a database row maps to the API entity (snake_case columns ->
 * camelCase fields), and its own create/update methods with explicit columns.
 *
 * `table`, `orderBy` and the column names in buildUpdate() are always fixed
 * strings written in the subclass, never request input, so putting them in the
 * SQL text is safe; every VALUE goes through $1, $2, ... parameters.
 */
export abstract class Repository<TEntity, TRow extends QueryResultRow = QueryResultRow> {
  protected constructor(
    protected readonly db: Queryable,
    protected readonly table: string,
    protected readonly orderBy: string = "created_at DESC"
  ) {}

  protected abstract toEntity(row: TRow): TEntity;

  /** Every query goes through here so database errors become proper HTTP errors. */
  protected async query<R extends QueryResultRow = TRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  async findById(id: string): Promise<TEntity | null> {
    if (!isUuid(id)) return null;
    const result = await this.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? this.toEntity(row) : null;
  }

  async findAll({ limit = 50, offset = 0 }: ListOptions = {}): Promise<TEntity[]> {
    const result = await this.query(`SELECT * FROM ${this.table} ORDER BY ${this.orderBy} LIMIT $1 OFFSET $2`, [
      limit,
      offset,
    ]);
    return result.rows.map((row) => this.toEntity(row));
  }

  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * UPDATE for a partial (PATCH) payload: only fields present in `input` AND
   * listed in `columns` (API field -> column name) are written, and
   * updated_at is always refreshed. Returns null if the row does not exist.
   */
  protected async updateColumns(
    id: string,
    columns: Record<string, string>,
    input: Record<string, unknown>
  ): Promise<TEntity | null> {
    if (!isUuid(id)) return null;
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, column] of Object.entries(columns)) {
      if (input[field] === undefined) continue;
      values.push(input[field]);
      sets.push(`${column} = $${values.length}`);
    }
    sets.push("updated_at = now()");
    const result = await this.query(
      `UPDATE ${this.table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    const row = result.rows[0];
    return row ? this.toEntity(row) : null;
  }
}
