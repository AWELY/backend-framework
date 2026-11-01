import { Repository, type Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import type { Customer, ProfileInput } from "./customers.schema";

/** شكل الصف في جدول customers، وفيه password_hash. */
interface CustomerRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

/** مستودع الزبائن. */
export class CustomersRepository extends Repository<Customer, CustomerRow> {
  constructor(db: Queryable) {
    super(db, "customers");
  }

  /**
   * صف القاعدة إلى كائن الـ API، ويحذف password_hash عمداً: الـ hash يجب ألا يخرج من
   * المستودع عبر الكائن العادي أبداً. هكذا لا يمكن أن يظهر في أي رد للـ API بالخطأ،
   * حتى لو كتب أحد res.json(customer) في مسار جديد.
   */
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

  /** ينشئ حساباً. يستلم الـ hash جاهزاً، فالمستودع لا يرى كلمة المرور نفسها أبداً. */
  async create(input: { email: string; passwordHash: string; name: string; phone?: string }): Promise<Customer> {
    const result = await this.query(
      "INSERT INTO customers (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING *",
      [input.email, input.passwordHash, input.name, input.phone ?? null]
    );
    return this.toEntity(result.rows[0] as CustomerRow);
  }

  /**
   * الدالة الوحيدة التي ترجع الـ hash، ويستخدمها الدخول فقط، ولا شيء غيره.
   * البحث بـ lower(email) يطابق البريد مهما اختلفت حالة حروفه، ويستفيد من الفهرس
   * customers_email_key المبني على lower(email).
   */
  async findCredentials(email: string): Promise<{ customer: Customer; passwordHash: string } | null> {
    const result = await this.query("SELECT * FROM customers WHERE lower(email) = lower($1)", [email]);
    const row = result.rows[0];
    return row ? { customer: this.toEntity(row), passwordHash: row.password_hash } : null;
  }

  /** يعدّل الاسم أو الهاتف فقط. هذان العمودان وحدهما في القائمة، فلا يمكن تعديل غيرهما. */
  updateProfile(id: string, input: Partial<ProfileInput>): Promise<Customer | null> {
    return this.updateColumns(id, { name: "name", phone: "phone" }, input);
  }
}

/** رمز المستودع في الحاوية. */
export const CUSTOMERS_REPOSITORY = createToken<CustomersRepository>("CustomersRepository");
