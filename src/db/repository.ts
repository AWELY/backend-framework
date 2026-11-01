import type { QueryResult, QueryResultRow } from "pg";
import { translateDbError } from "./errors";
import { isUuid } from "./ids";
import { PreconditionFailedError } from "../engine/errors";

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
 * صفحة من نتائج قائمة: العناصر، والعدد الكلي للنتائج المطابقة (كل الصفحات).
 * الـ API يرسل العناصر في الجسم كما كان، والعدد الكلي في ترويسة X-Total-Count، فيعرف الموقع
 * عدد الصفحات دون أن يتغير شكل الرد.
 */
export interface ListPage<T> {
  items: T[];
  total: number;
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
 * والصنف الأب هنا يعطي الباقي جاهزاً: findById و findAll و findPage و delete و updateColumns.
 *
 * لماذا لا ORM؟ خفة، وكل استعلام ظاهر ومقروء. والحماية من SQL Injection تأتي من المعاملات:
 * القيمة ترسل منفصلة عن نص الاستعلام، فلا تُعامل كجزء من SQL أبداً.
 *
 * أمان: اسم الجدول، و orderBy، وأسماء الأعمدة في updateColumns، كلها نصوص ثابتة مكتوبة
 * في الصنف الابن، ولا تأتي من الطلب أبداً، لذلك وضعها داخل نص SQL آمن. أما كل قيمة
 * فتمر عبر $1 و $2 ...
 *
 * التعديل المتفائل (Optimistic concurrency): الجدول الذي فيه عمود version (versioned = true)
 * يزيد رقمه مع كل تعديل. من يعدّل يستطيع أن يقول "عدّل فقط إن كانت النسخة ما زالت 3"
 * (expectedVersion، من ترويسة If-Match). إن عدّل أحد غيره قبله، يرفض بـ 412 بدل أن يكتب فوقه.
 *
 * TEntity: شكل الكائن في الـ API. TRow: شكل الصف في القاعدة.
 */
export abstract class Repository<TEntity, TRow extends QueryResultRow = QueryResultRow> {
  protected constructor(
    protected readonly db: Queryable,
    protected readonly table: string,
    /** الترتيب الافتراضي للقوائم: الأحدث أولاً. */
    protected readonly orderBy: string = "created_at DESC",
    /** هل في الجدول عمود version للتعديل المتفائل؟ */
    protected readonly versioned: boolean = false
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
  async findAll(options: ListOptions = {}): Promise<TEntity[]> {
    return (await this.findPage(options)).items;
  }

  /** مثل findAll، ومعها العدد الكلي للصفوف. */
  async findPage({ limit = 50, offset = 0 }: ListOptions = {}): Promise<ListPage<TEntity>> {
    return this.page(`SELECT * FROM ${this.table}`, [], this.orderBy, limit, offset);
  }

  /**
   * ينفّذ استعلام قائمة (base، دون ORDER BY ولا LIMIT) ويرجع صفحة منه مع العدد الكلي.
   *
   * COUNT(*) OVER() "دالة نافذة" (Window function): تحسب عدد كل الصفوف المطابقة قبل تطبيق
   * LIMIT، وتضعه في كل صف، فنحصل على الصفحة والعدد في استعلام واحد. استثناء واحد: صفحة بعد
   * آخر النتائج لا ترجع صفوفاً يُقرأ منها العدد، فنعدّ باستعلام ثانٍ.
   */
  protected async page(
    base: string,
    values: unknown[],
    orderBy: string,
    limit: number,
    offset: number
  ): Promise<ListPage<TEntity>> {
    const n = values.length;
    const result = await this.query<TRow & { __total: number }>(
      `SELECT q.*, COUNT(*) OVER() AS __total FROM (${base}) q ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...values, limit, offset]
    );
    let total = result.rows[0]?.__total ?? 0;
    if (result.rows.length === 0 && offset > 0) {
      const count = await this.query<{ total: number }>(`SELECT COUNT(*) AS total FROM (${base}) q`, values);
      total = count.rows[0]?.total ?? 0;
    }
    return { items: result.rows.map((row) => this.toEntity(row)), total };
  }

  /**
   * يحذف صفاً برقمه. يرجع true إن حُذف فعلاً، و false إن لم يوجد.
   * expectedVersion (للجداول versioned): يحذف فقط إن كانت النسخة مطابقة، وإلا 412.
   */
  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    if (!isUuid(id)) return false;
    const versionCheck = this.versioned && expectedVersion !== undefined;
    const result = await this.query(
      `DELETE FROM ${this.table} WHERE id = $1${versionCheck ? " AND version = $2" : ""}`,
      versionCheck ? [id, expectedVersion] : [id]
    );
    if ((result.rowCount ?? 0) > 0) return true;
    if (versionCheck) await this.assertMissingOrStale(id);
    return false;
  }

  /**
   * تعديل جزئي لطلبات PATCH: يكتب فقط الحقول الموجودة في input والمذكورة في columns
   * (مفتاح columns اسم الحقل في الـ API، وقيمته اسم العمود في الجدول)، ويحدّث updated_at
   * دائماً (و version إن كان الجدول versioned). يرجع null إن لم يوجد الصف.
   *
   * القيمة null تُكتب فعلاً (تمسح العمود)، أما الحقل غير الموجود (undefined) فلا يُلمس.
   *
   * مثال: input = { price: 70000 } و columns = { name: "name", price: "price" }
   *   values = [id, 70000]
   *   SQL:   UPDATE products SET price = $2, updated_at = now() WHERE id = $1 RETURNING *
   * و RETURNING * يرجع الصف بعد التعديل في نفس الاستعلام.
   */
  protected async updateColumns(
    id: string,
    columns: Record<string, string>,
    input: Record<string, unknown>,
    expectedVersion?: number
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
    if (this.versioned) sets.push("version = version + 1");
    let where = "id = $1";
    const versionCheck = this.versioned && expectedVersion !== undefined;
    if (versionCheck) {
      values.push(expectedVersion);
      where += ` AND version = $${values.length}`;
    }
    const result = await this.query(`UPDATE ${this.table} SET ${sets.join(", ")} WHERE ${where} RETURNING *`, values);
    const row = result.rows[0];
    if (row) return this.toEntity(row);
    if (versionCheck) await this.assertMissingOrStale(id);
    return null;
  }

  /** بعد تعديل لم يلمس أي صف بشرط النسخة: إن كان الصف موجوداً فالنسخة قديمة (412)، وإلا فهو غير موجود. */
  private async assertMissingOrStale(id: string): Promise<void> {
    const { rows } = await this.query<{ version: number }>(`SELECT version FROM ${this.table} WHERE id = $1`, [id]);
    const current = rows[0];
    if (current) throw new PreconditionFailedError(undefined, { currentVersion: current.version });
  }
}
