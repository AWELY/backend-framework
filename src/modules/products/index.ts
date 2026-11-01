import type { CommerceModule } from "../types";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { withTransaction } from "../../db/transaction";
import { found, sendPage, etag, expectedVersion, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import { productsMigrations, productInputSchema, productListQuery, variantInputSchema } from "./products.schema";
import { ProductsRepository, PRODUCTS_REPOSITORY } from "./products.repository";

const VARIANT_PARAMS = {
  id: { type: "string", maxLength: 100 },
  variantId: { type: "string", maxLength: 100 },
} as const;

/**
 * وحدة المنتجات وأشكالها.
 *
 * المسارات:
 *   GET    /products                         عام: النشطة فقط. من يملك products:write (المالك والمدير والمشرف): كل المنتجات.
 *                                            ?categoryId= &q= (بحث) &sort= &limit= &offset=، والعدد في X-Total-Count
 *   GET    /products/by-slug/:slug           نفس GET /products/:id لكن بالرابط المقروء
 *   GET    /products/:id                     المنتج مع أشكاله، وترويسة ETag
 *   POST   /products                         products:write
 *   PATCH  /products/:id                     products:write. If-Match اختياري (412 إن عدّل غيرك قبلك)
 *   DELETE /products/:id                     products:write. If-Match اختياري
 *   GET    /products/:id/variants            الأشكال (النشطة فقط للعامة)
 *   POST   /products/:id/variants            products:write
 *   PATCH  /products/:id/variants/:variantId products:write
 *   DELETE /products/:id/variants/:variantId products:write
 *
 * الكتابة تحدث داخل معاملة تكتب معها حدث product.created أو updated أو deleted في صندوق الصادر،
 * فلا يتغير منتج دون حدثه، ولا يُطلق حدث لتغيير أُلغي.
 * القراءة تمر بالحاوية (container.resolve)، فيستطيع متجر أو إضافة استبدال المستودع (مثلاً بنسخة
 * فيها ذاكرة مؤقتة للقراءة، انظر examples/plugins/cached-products.ts).
 */
export const productsModule: CommerceModule = {
  name: "products",
  migrations: productsMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional, events }) {
    container.register(PRODUCTS_REPOSITORY, () => new ProductsRepository(pool));
    const repo = () => container.resolve(PRODUCTS_REPOSITORY);
    const canWrite = requirePermission(accessControl, "products:write");
    const isWriter = (role: string | undefined) => accessControl.can(role, "products:write");

    router.get(
      "/products",
      authenticateOptional,
      withInput({ query: { ...productListQuery, ...PAGINATION_QUERY }, summary: "List products" }, async (req, res, { query }) => {
        sendPage(
          res,
          await repo().listPage({
            categoryId: query.categoryId,
            q: query.q,
            sort: query.sort,
            includeInactive: isWriter(req.auth?.role),
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
          })
        );
      })
    );

    /** المنتج مع أشكاله، بشرط أن يكون مرئياً لهذا المرسل. */
    async function visibleProduct(product: Awaited<ReturnType<ProductsRepository["findById"]>>, role: string | undefined) {
      const writer = isWriter(role);
      if (!product || (!product.isActive && !writer)) return null;
      return { ...product, variants: await repo().listVariants(product.id, { includeInactive: writer }) };
    }

    router.get(
      "/products/by-slug/:slug",
      authenticateOptional,
      withInput({ params: { slug: { type: "string", maxLength: 200 } }, summary: "Get a product by slug" }, async (req, res, { params }) => {
        const product = found(await visibleProduct(await repo().findBySlug(params.slug), req.auth?.role), "Product");
        res.setHeader("ETag", etag(product.version));
        res.json(product);
      })
    );

    router.get(
      "/products/:id",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "Get a product with its variants" }, async (req, res, { params }) => {
        const product = found(await visibleProduct(await repo().findById(params.id), req.auth?.role), "Product");
        res.setHeader("ETag", etag(product.version));
        res.json(product);
      })
    );

    router.post(
      "/products",
      authenticate,
      canWrite,
      withInput({ body: productInputSchema, summary: "Create a product", successStatus: 201 }, async (_req, res, { body }) => {
        const product = await withTransaction(pool, async (client) => {
          const created = await new ProductsRepository(client).create(body);
          await events.publish(client, "product.created", { product: created });
          return created;
        });
        events.notify();
        res.setHeader("ETag", etag(product.version));
        res.status(201).json(product);
      })
    );

    router.patch(
      "/products/:id",
      authenticate,
      canWrite,
      withInput(
        { params: ID_PARAMS, body: productInputSchema, partial: true, summary: "Update a product (If-Match supported)", conditional: true },
        async (req, res, { params, body }) => {
          const version = expectedVersion(req);
          const product = await withTransaction(pool, async (client) => {
            const updated = await new ProductsRepository(client).update(params.id, body, version);
            if (updated) await events.publish(client, "product.updated", { product: updated });
            return updated;
          });
          found(product, "Product");
          events.notify();
          res.setHeader("ETag", etag((product as { version: number }).version));
          res.json(product);
        }
      )
    );

    router.delete(
      "/products/:id",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, summary: "Delete a product (If-Match supported)", conditional: true, successStatus: 204 }, async (req, res, { params }) => {
        const version = expectedVersion(req);
        const deleted = await withTransaction(pool, async (client) => {
          const ok = await new ProductsRepository(client).delete(params.id, version);
          if (ok) await events.publish(client, "product.deleted", { productId: params.id });
          return ok;
        });
        found(deleted ? true : null, "Product");
        events.notify();
        res.status(204).end();
      })
    );

    router.get(
      "/products/:id/variants",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "List a product's variants" }, async (req, res, { params }) => {
        const product = found(await visibleProduct(await repo().findById(params.id), req.auth?.role), "Product");
        res.json(product.variants);
      })
    );

    router.post(
      "/products/:id/variants",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, body: variantInputSchema, summary: "Add a variant", successStatus: 201 }, async (_req, res, { params, body }) => {
        found(await repo().findById(params.id), "Product");
        res.status(201).json(await repo().createVariant(params.id, body));
      })
    );

    router.patch(
      "/products/:id/variants/:variantId",
      authenticate,
      canWrite,
      withInput({ params: VARIANT_PARAMS, body: variantInputSchema, partial: true, summary: "Update a variant" }, async (_req, res, { params, body }) => {
        res.json(found(await repo().updateVariant(params.id, params.variantId, body), "Variant"));
      })
    );

    router.delete(
      "/products/:id/variants/:variantId",
      authenticate,
      canWrite,
      withInput({ params: VARIANT_PARAMS, summary: "Delete a variant", successStatus: 204 }, async (_req, res, { params }) => {
        found((await repo().deleteVariant(params.id, params.variantId)) ? true : null, "Variant");
        res.status(204).end();
      })
    );
  },
};
