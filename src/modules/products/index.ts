import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { found, parsePagination } from "../shared";
import { productsMigrations, productInputSchema, type ProductInput } from "./products.schema";
import { ProductsRepository, PRODUCTS_REPOSITORY } from "./products.repository";

/**
 * وحدة المنتجات.
 *
 * المسارات:
 *   GET    /products?categoryId=&limit=&offset=   عام: المنتجات النشطة فقط، والمالك يرى غير النشطة أيضاً
 *   GET    /products/:id                          عام: النشط فقط، والمالك يرى غير النشط أيضاً
 *   POST   /products                              يتطلب products:write (المالك)
 *   PATCH  /products/:id                          products:write
 *   DELETE /products/:id                          products:write
 *
 * المنتج "غير النشط" (isActive = false) مخفي عن الزبائن دون حذفه، مثلاً منتج توقف بيعه
 * مؤقتاً. حذفه نهائياً يحذف مخزونه وسطوره في السلال (ON DELETE CASCADE)، أما الطلبات
 * القديمة فتحتفظ باسمه وسعره لأنها نسختهما وقت الشراء.
 *
 * المخزون ليس هنا، بل في وحدة المخزون. هكذا لا تعتمد المنتجات على المخزون، والمخزون هو
 * الذي يعتمد على المنتجات (اعتماد في اتجاه واحد، فلا حلقات بين الوحدات).
 */
export const productsModule: CommerceModule = {
  name: "products",
  migrations: productsMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional }) {
    container.register(PRODUCTS_REPOSITORY, () => new ProductsRepository(pool));
    const repo = () => container.resolve(PRODUCTS_REPOSITORY);
    const canWrite = requirePermission(accessControl, "products:write");

    // قائمة المنتجات. authenticateOptional: الزائر يرى القائمة، وإن كان المرسل المالك
    // نعرف ذلك فنعرض له غير النشطة أيضاً.
    router.get("/products", authenticateOptional, async (req, res) => {
      const { limit, offset } = parsePagination(req.query);
      res.json(
        await repo().list({
          // تصفية حسب القسم إن أُرسل ?categoryId=...
          categoryId: req.query.get("categoryId") ?? undefined,
          // من يملك صلاحية التعديل (المالك) يرى المنتجات المخفية أيضاً.
          includeInactive: accessControl.can(req.auth?.role, "products:write"),
          limit,
          offset,
        })
      );
    });

    // منتج واحد. المنتج غير النشط يظهر للزبون كأنه غير موجود (404)، ويظهر للمالك.
    router.get("/products/:id", authenticateOptional, async (req, res) => {
      const product = await repo().findById(req.params.id as string);
      const visible = product && (product.isActive || accessControl.can(req.auth?.role, "products:write"));
      res.json(found(visible ? product : null, "Product"));
    });

    // إضافة منتج: المالك فقط، وبيانات متحقق منها. slug مكرر يعطي 409 من قيد UNIQUE.
    router.post("/products", authenticate, canWrite, validateBody(productInputSchema), async (req, res) => {
      res.status(201).json(await repo().create(req.body as ProductInput));
    });

    // تعديل جزئي، مثل تغيير السعر وحده: { "price": 70000 }
    router.patch(
      "/products/:id",
      authenticate,
      canWrite,
      validateBody(productInputSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().update(req.params.id as string, req.body as Partial<ProductInput>), "Product"));
      }
    );

    // حذف نهائي. للإخفاء المؤقت الأفضل PATCH بـ { "isActive": false }.
    router.delete("/products/:id", authenticate, canWrite, async (req, res) => {
      found((await repo().delete(req.params.id as string)) ? true : null, "Product");
      res.status(204).end();
    });
  },
};
