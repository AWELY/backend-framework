import type { QueryResult, QueryResultRow } from "pg";
import { translateDbError } from "./errors";
import { isUuid } from "./ids";

/**
 * أي شيء يستطيع تنفيذ استعلام:
 *   - مجموعة الاتصالات المشتركة (Pool) في الحالة العادية.
 *   - أو اتصال واحد (PoolClient) داخل معاملة withTransaction.
 * المستودعات تقبل الاثنين، فنفس صنف المستودع يعمل داخل المعاملة وخارجها.
 * مثال: في checkout يُنشأ مستودع المخزون بالاتصال الخاص بالمعاملة، فيصبح إنقاص المخزون
 * جزءاً منها.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** الترقيم (Pagination): كم صفاً، ومن أين نبدأ. */
export interface ListOptions {
  limit?: number;
  offset?: number;
}

/**
 * نمط المستودع (Repository pattern): كل الوصول إلى جدول يمر عبر صنف واحد.
 * فوق SQL مكتوب يدوياً بمعاملات ($1، $2...)، ودون ORM.
 *
 * الصنف الابن (مثل ProductsRepository) يعطي ثلاثة أشياء:
 *   1. اسم جدوله.
 *   2. كيف يتحول صف القاعدة إلى كائن الـ API (toEntity): أسماء الأعمدة snake_case
 *      مثل category_id تصبح camelCase مثل categoryId.
 *   3. دوال الإنشاء والتعديل الخاصة به، بأعمدة مكتوبة صراحة.
 * والصنف الأب هنا يعطي الباقي جاهزاً: findById و findAll و delete و updateColumns.
 *
 * لماذا لا ORM؟ خفة، وكل استعلام ظاهر ومقروء. والحماية من SQL Injection تأتي من المعاملات:
 * القيمة ترسل منفصلة عن نص الاستعلام، فلا تُعامل كجزء من SQL أبداً.
 *
 * أمان: اسم الجدول، و orderBy، وأسماء الأعمدة في updateColumns، كلها نصوص ثابتة مكتوبة
 * في الصنف الابن، ولا تأتي من الطلب أبداً، لذلك وضعها داخل نص SQL آمن. أما كل قيمة
 * فتمر عبر $1 و $2 ...
 *
 * TEntity: شكل الكائن في الـ API. TRow: شكل الصف في القاعدة.
 */
export abstract class Repository<TEntity, TRow extends QueryResultRow = QueryResultRow> {
  // protected: يصل إليها الصنف الابن، ولا يصل إليها من هو خارج الأصناف.
  protected constructor(
    protected readonly db: Queryable,
    protected readonly table: string,
    /** الترتيب الافتراضي للقوائم: الأحدث أولاً. */
    protected readonly orderBy: string = "created_at DESC"
  ) {}

  /** يحوّل صفاً من القاعدة إلى كائن الـ API. كل صنف ابن يكتبها (abstract). */
  protected abstract toEntity(row: TRow): TEntity;

  /**
   * كل استعلام يمر من هنا، فتتحول أخطاء القاعدة إلى أخطاء HTTP صحيحة (db/errors.ts):
   * بريد مكرر يعطي 409، لا 500.
   */
  protected async query<R extends QueryResultRow = TRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** صف واحد برقمه، أو null. رقم ليس UUID يعطي null مباشرة، دون استعلام. */
  async findById(id: string): Promise<TEntity | null> {
    if (!isUuid(id)) return null;
    const result = await this.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? this.toEntity(row) : null;
  }

  /** صفحة من الصفوف: limit صفاً (الافتراضي 50) بعد تجاوز offset صفاً. */
  async findAll({ limit = 50, offset = 0 }: ListOptions = {}): Promise<TEntity[]> {
    const result = await this.query(`SELECT * FROM ${this.table} ORDER BY ${this.orderBy} LIMIT $1 OFFSET $2`, [
      limit,
      offset,
    ]);
    return result.rows.map((row) => this.toEntity(row));
  }

  /** يحذف صفاً برقمه. يرجع true إن حُذف فعلاً، و false إن لم يوجد. */
  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    // rowCount: عدد الصفوف التي تأثرت. "?? 0" لأن نوعه قد يكون null.
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * تعديل جزئي لطلبات PATCH: يكتب فقط الحقول الموجودة في input والمذكورة في columns
   * (مفتاح columns اسم الحقل في الـ API، وقيمته اسم العمود في الجدول)، ويحدّث updated_at
   * دائماً. يرجع null إن لم يوجد الصف.
   *
   * مثال: input = { price: 70000 } و columns = { name: "name", price: "price" }
   *   values = [id, 70000]
   *   SQL:   UPDATE products SET price = $2, updated_at = now() WHERE id = $1 RETURNING *
   * و RETURNING * يرجع الصف بعد التعديل في نفس الاستعلام.
   */
  protected async updateColumns(
    id: string,
    columns: Record<string, string>,
    input: Record<string, unknown>
  ): Promise<TEntity | null> {
    if (!isUuid(id)) return null;
    const sets: string[] = [];
    // $1 محجوز للرقم id، والقيم الأخرى تأخذ $2 و $3 ... بترتيب إضافتها.
    const values: unknown[] = [id];
    for (const [field, column] of Object.entries(columns)) {
      // حقل لم يُرسل: لا نلمس عموده.
      if (input[field] === undefined) continue;
      values.push(input[field]);
      // رقم المعامل = عدد القيم الآن، فأول حقل يأخذ $2.
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
