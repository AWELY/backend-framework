import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { found, parsePagination } from "../shared";
import { categoriesMigrations, categoryInputSchema, type CategoryInput } from "./categories.schema";
import { CategoriesRepository, CATEGORIES_REPOSITORY } from "./categories.repository";

/**
 * وحدة الأقسام. أبسط وحدة في الإطار، وهي النموذج الذي تتبعه كل الوحدات الأخرى:
 *   ملف schema   : الجدول (migration) + قواعد التحقق + شكل البيانات.
 *   ملف repository: الوصول إلى الجدول بـ SQL.
 *   ملف index    : تسجيل المستودع في الحاوية، والمسارات في الـ Router.
 *
 * الأقسام مسطحة: لا أقسام فرعية متداخلة. المتجر الصغير لا يحتاج شجرة، والشجرة تضيف فحص
 * الحلقات (قسم داخل نفسه) واستعلامات متكررة (Recursive).
 *
 * المسارات:
 *   GET    /categories           عام، لأي أحد
 *   GET    /categories/:id       عام
 *   POST   /categories           يتطلب الصلاحية categories:write (المالك)
 *   PATCH  /categories/:id       categories:write
 *   DELETE /categories/:id       categories:write
 *          (المنتجات لا تُحذف مع القسم، بل يصبح category_id فيها NULL)
 */
export const categoriesModule: CommerceModule = {
  name: "categories",
  migrations: categoriesMigrations,

  // register تستلم صندوق الأدوات (ModuleContext)، ونأخذ منه فقط ما نحتاجه (Destructuring).
  register({ router, container, pool, accessControl, authenticate }) {
    // 1. نسجل "وصفة" المستودع في الحاوية. لا يُنشأ الآن، بل عند أول طلب.
    container.register(CATEGORIES_REPOSITORY, () => new CategoriesRepository(pool));
    // دالة مختصرة: كل مسار يطلب المستودع من الحاوية عند تنفيذه.
    const repo = () => container.resolve(CATEGORIES_REPOSITORY);
    // معالج تفويض جاهز، نضعه في سلسلة المسارات التي تعدّل البيانات.
    const canWrite = requirePermission(accessControl, "categories:write");

    // 2. المسارات.

    // قائمة الأقسام، مع الترقيم: ?limit=&offset=
    router.get("/categories", async (req, res) => {
      res.json(await repo().findAll(parsePagination(req.query)));
    });

    // قسم واحد برقمه، أو 404. "as string" لأن TypeScript لا يعرف أن الـ Router وضع id حتماً.
    router.get("/categories/:id", async (req, res) => {
      res.json(found(await repo().findById(req.params.id as string), "Category"));
    });

    // إنشاء قسم. السلسلة: من أنت؟ ← هل يحق لك؟ ← هل بياناتك صحيحة؟ ← التنفيذ. والرد 201 (أُنشئ).
    router.post("/categories", authenticate, canWrite, validateBody(categoryInputSchema), async (req, res) => {
      res.status(201).json(await repo().create(req.body as CategoryInput));
    });

    // تعديل جزئي: partial: true تجعل كل الحقول اختيارية، فيُرسل العميل ما يريد تغييره فقط.
    router.patch(
      "/categories/:id",
      authenticate,
      canWrite,
      validateBody(categoryInputSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().update(req.params.id as string, req.body as Partial<CategoryInput>), "Category"));
      }
    );

    // حذف. delete ترجع true أو false، فنحوّل false إلى null ليرمي found خطأ 404.
    // الرد 204: نجح، ولا جسم.
    router.delete("/categories/:id", authenticate, canWrite, async (req, res) => {
      found((await repo().delete(req.params.id as string)) ? true : null, "Category");
      res.status(204).end();
    });
  },
};
