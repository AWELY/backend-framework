import type { CommerceModule } from "../types";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { found, sendPage, etag, expectedVersion, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import { categoriesMigrations, categoryInputSchema } from "./categories.schema";
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
 *   GET    /categories           عام، لأي أحد. العدد الكلي في X-Total-Count
 *   GET    /categories/:id       عام. يرد بـ ETag (رقم النسخة)
 *   POST   /categories           يتطلب الصلاحية categories:write
 *   PATCH  /categories/:id       categories:write. يقبل If-Match (412 إن عدّل غيرك قبلك)
 *   DELETE /categories/:id       categories:write. يقبل If-Match
 *          (المنتجات لا تُحذف مع القسم، بل يصبح category_id فيها NULL)
 */
export const categoriesModule: CommerceModule = {
  name: "categories",
  migrations: categoriesMigrations,

  register({ router, container, pool, accessControl, authenticate }) {
    container.register(CATEGORIES_REPOSITORY, () => new CategoriesRepository(pool));
    const repo = () => container.resolve(CATEGORIES_REPOSITORY);
    const canWrite = requirePermission(accessControl, "categories:write");

    router.get(
      "/categories",
      withInput({ query: PAGINATION_QUERY, summary: "List categories" }, async (_req, res, { query }) => {
        sendPage(res, await repo().findPage({ limit: query.limit ?? 50, offset: query.offset ?? 0 }));
      })
    );

    router.get(
      "/categories/:id",
      withInput({ params: ID_PARAMS, summary: "Get a category" }, async (_req, res, { params }) => {
        const category = found(await repo().findById(params.id), "Category");
        res.setHeader("ETag", etag(category.version));
        res.json(category);
      })
    );

    router.post(
      "/categories",
      authenticate,
      canWrite,
      withInput({ body: categoryInputSchema, summary: "Create a category", successStatus: 201 }, async (_req, res, { body }) => {
        const category = await repo().create(body);
        res.setHeader("ETag", etag(category.version));
        res.status(201).json(category);
      })
    );

    router.patch(
      "/categories/:id",
      authenticate,
      canWrite,
      withInput(
        { params: ID_PARAMS, body: categoryInputSchema, partial: true, summary: "Update a category (If-Match supported)", conditional: true },
        async (req, res, { params, body }) => {
          const category = found(await repo().update(params.id, body, expectedVersion(req)), "Category");
          res.setHeader("ETag", etag(category.version));
          res.json(category);
        }
      )
    );

    router.delete(
      "/categories/:id",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, summary: "Delete a category (If-Match supported)", conditional: true, successStatus: 204 }, async (req, res, { params }) => {
        found((await repo().delete(params.id, expectedVersion(req))) ? true : null, "Category");
        res.status(204).end();
      })
    );
  },
};
