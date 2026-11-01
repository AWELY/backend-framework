import { Repository, type Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import type { Category, CategoryInput } from "./categories.schema";

/** شكل الصف كما يرجع من جدول categories (أسماء الأعمدة بأسلوب snake_case). */
interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * مستودع الأقسام. يرث من Repository الدوال الجاهزة findById و findAll و delete و updateColumns،
 * ويضيف فقط ما يخص هذا الجدول: التحويل toEntity، والإنشاء، والتعديل.
 */
export class CategoriesRepository extends Repository<Category, CategoryRow> {
  constructor(db: Queryable) {
    // اسم الجدول، والترتيب الافتراضي للقوائم: أبجدياً حسب الاسم.
    super(db, "categories", "name ASC", true);
  }

  /** صف القاعدة إلى كائن الـ API: created_at يصبح createdAt، وهكذا. */
  protected toEntity(row: CategoryRow): Category {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * ينشئ قسماً. القيم تمر عبر $1 و $2 و $3 (حماية من SQL Injection).
   * id و created_at و updated_at تملؤها القاعدة بقيمها الافتراضية،
   * و RETURNING * يرجع الصف الجديد كاملاً في نفس الاستعلام.
   * slug مكرر يجعل القاعدة ترفض (قيد UNIQUE)، فيتحول إلى رد 409 (db/errors.ts).
   */
  async create(input: CategoryInput): Promise<Category> {
    const result = await this.query(
      "INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3) RETURNING *",
      [input.name, input.slug, input.description ?? null]
    );
    return this.toEntity(result.rows[0] as CategoryRow);
  }

  /** تعديل جزئي: الحقول المسموح تعديلها وأعمدتها. انظر updateColumns في db/repository.ts. */
  update(id: string, input: Partial<CategoryInput>, expectedVersion?: number): Promise<Category | null> {
    return this.updateColumns(id, { name: "name", slug: "slug", description: "description" }, input, expectedVersion);
  }
}

/** رمز المستودع في حاوية الـ DI. تطلبه الوحدات الأخرى به إن احتاجت. */
export const CATEGORIES_REPOSITORY = createToken<CategoriesRepository>("CategoriesRepository");
