import { Repository, type ListPage, type Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Customer, ProfileInput } from "./customers.schema";

interface CustomerRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * مستودع الزبائن. كلمة المرور لا تخرج منه أبداً إلا عبر findCredentials (للدخول فقط):
 * toEntity لا يضع password_hash في كائن الـ API.
 */
export class CustomersRepository extends Repository<Customer, CustomerRow> {
  constructor(db: Queryable) {
    super(db, "customers");
  }

  protected toEntity(row: CustomerRow): Customer {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(input: { email: string; passwordHash: string; name: string; phone?: string }): Promise<Customer> {
    const result = await this.query(
      "INSERT INTO customers (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING *",
      [input.email, input.passwordHash, input.name, input.phone ?? null]
    );
    return this.toEntity(result.rows[0] as CustomerRow);
  }

  /** الزبون مع بصمة كلمة مروره، بالبريد (للدخول). */
  async findCredentials(email: string): Promise<{ customer: Customer; passwordHash: string } | null> {
    const result = await this.query("SELECT * FROM customers WHERE lower(email) = lower($1)", [email]);
    const row = result.rows[0];
    return row ? { customer: this.toEntity(row), passwordHash: row.password_hash } : null;
  }

  /** بصمة كلمة مرور زبون برقمه (لتغيير كلمة المرور). */
  async passwordHashOf(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const result = await this.query<{ password_hash: string }>("SELECT password_hash FROM customers WHERE id = $1", [id]);
    return result.rows[0]?.password_hash ?? null;
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.query("UPDATE customers SET password_hash = $2, updated_at = now() WHERE id = $1", [id, passwordHash]);
  }

  updateProfile(id: string, input: Partial<ProfileInput>): Promise<Customer | null> {
    return this.updateColumns(id, { name: "name", phone: "phone" }, input);
  }

  /** صفحة من الزبائن، مع بحث اختياري في البريد والاسم والهاتف. */
  async search(filter: { q?: string; limit: number; offset: number }): Promise<ListPage<Customer>> {
    if (!filter.q) return this.findPage(filter);
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.page(
      "SELECT * FROM customers WHERE email ILIKE $1 OR name ILIKE $1 OR phone ILIKE $1",
      [pattern],
      "created_at DESC",
      filter.limit,
      filter.offset
    );
  }

  /** يحفظ بصمة رمز استعادة جديد صالح لمدة ttlMinutes. */
  async createPasswordReset(customerId: string, tokenHash: string, ttlMinutes: number): Promise<Date> {
    const { rows } = await this.query<{ expires_at: Date }>(
      `INSERT INTO password_resets (customer_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`,
      [customerId, tokenHash, ttlMinutes]
    );
    return (rows[0] as { expires_at: Date }).expires_at;
  }

  /**
   * يستهلك رمز استعادة: يعلّمه مستخدماً ويرجع رقم الزبون، أو null إن كان غير موجود أو مستخدماً
   * أو منتهياً. استعلام واحد ذري: طلبان بنفس الرمز في نفس اللحظة لا ينجحان معاً.
   */
  async consumePasswordReset(tokenHash: string): Promise<string | null> {
    const { rows } = await this.query<{ customer_id: string }>(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING customer_id`,
      [tokenHash]
    );
    return rows[0]?.customer_id ?? null;
  }
}

export const CUSTOMERS_REPOSITORY = createToken<CustomersRepository>("CustomersRepository");
