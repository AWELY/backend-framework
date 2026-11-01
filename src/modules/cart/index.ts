import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { ConflictError, NotFoundError } from "../../engine/errors";
import { PRODUCTS_REPOSITORY } from "../products/products.repository";
import { INVENTORY_REPOSITORY } from "../inventory/inventory.repository";
import { cartMigrations, addItemSchema, setItemSchema } from "./cart.schema";
import { CartRepository, CART_REPOSITORY } from "./cart.repository";
import { assertCartAccess, assertCartOpen } from "./cart.access";

/**
 * وحدة سلة التسوق. تعمل للضيف وللزبون المسجل دخوله معاً.
 *
 * المسارات:
 *   POST   /carts                           إنشاء سلة (تُربط بالزبون إن كان مسجل الدخول)
 *   GET    /carts/:id                       قراءة السلة بسطورها ومجموعها
 *   POST   /carts/:id/items                 بجسم { productId, quantity }: يضيف الكمية إلى السطر
 *   PUT    /carts/:id/items/:productId      بجسم { quantity }: يضبط كمية السطر (0 تحذفه)
 *   DELETE /carts/:id/items/:productId      يحذف السطر
 *
 * المخزون يُفحص عند الإضافة (ليعرف المشتري فوراً إن كانت الكمية لا تكفي)، لكنه لا يُحجز
 * إلا عند إتمام الشراء (وحدة الطلبات)، داخل نفس المعاملة التي تنشئ الطلب. سلة متروكة
 * لا تحجز مخزوناً عن الآخرين.
 *
 * تعتمد على المنتجات والمخزون، وقد سُجّلتا قبلها (الترتيب في modules/index.ts).
 */
export const cartModule: CommerceModule = {
  name: "cart",
  migrations: cartMigrations,

  register({ router, container, pool, accessControl, authenticateOptional }) {
    container.register(CART_REPOSITORY, () => new CartRepository(pool));
    const carts = () => container.resolve(CART_REPOSITORY);
    // خدمات وحدتين أخريين، نطلبهما من الحاوية بدل إنشائهما هنا (حقن الاعتماديات).
    const products = () => container.resolve(PRODUCTS_REPOSITORY);
    const inventory = () => container.resolve(INVENTORY_REPOSITORY);

    /**
     * يتأكد أن المنتج موجود، ومعروض للبيع (نشط)، وأن المخزون يكفي للكمية الجديدة للسطر.
     * المنتج غير النشط يُعامل كغير موجود (404). المخزون غير الكافي يعطي 409 مع
     * المتوفر والمطلوب، فيستطيع الموقع أن يقول "المتوفر 3 فقط".
     */
    async function assertPurchasable(productId: string, lineQuantity: number): Promise<void> {
      const product = await products().findById(productId);
      if (!product || !product.isActive) throw new NotFoundError("Product not found");
      const stock = await inventory().get(productId);
      if (stock.quantity < lineQuantity) {
        throw new ConflictError("Insufficient stock", { productId, available: stock.quantity, requested: lineQuantity });
      }
    }

    // إنشاء سلة. نمرر "سلة ضيف" مؤقتة إلى assertCartAccess فقط لنعيد استخدام فحص
    // الصلاحية: إن كان المرسل معروفاً، يجب أن يملك cart:manage.
    router.post("/carts", authenticateOptional, async (req, res) => {
      assertCartAccess(req, { id: "", customerId: null, status: "open" }, accessControl);
      // الزبون المسجل تُربط السلة بحسابه. الضيف والمالك يحصلان على سلة غير مربوطة (null).
      const customerId = req.auth?.role === "customer" ? (req.auth.userId ?? null) : null;
      res.status(201).json(await carts().create(customerId));
    });

    // قراءة السلة، بعد التأكد أن المرسل يحق له رؤيتها (وإلا 404).
    router.get("/carts/:id", authenticateOptional, async (req, res) => {
      const id = req.params.id as string;
      assertCartAccess(req, await carts().findHeader(id), accessControl);
      res.json(await carts().findById(id));
    });

    /**
     * إضافة منتج: الكمية تُضاف إلى الموجود في السطر.
     * مثال: في السلة قطعتان، والطلب يضيف 3، فالسطر يصبح 5، ونفحص المخزون مقابل 5 لا 3.
     */
    router.post("/carts/:id/items", authenticateOptional, validateBody(addItemSchema), async (req, res) => {
      const id = req.params.id as string;
      // الترتيب: موجودة؟ ويحق لك؟ (assertCartAccess)، ثم ما زالت مفتوحة؟ (assertCartOpen)
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      const { productId, quantity } = req.body as { productId: string; quantity: number };
      const newQuantity = (await carts().quantityOf(id, productId)) + quantity;
      await assertPurchasable(productId, newQuantity);
      await carts().setLine(id, productId, newQuantity);
      // نرجع السلة كاملة بعد التعديل، فيحدّث الموقع عرضه برد واحد.
      res.json(await carts().findById(id));
    });

    // ضبط كمية سطر إلى رقم محدد. 0 تحذفه، ولا حاجة لفحص المخزون عند الحذف.
    router.put("/carts/:id/items/:productId", authenticateOptional, validateBody(setItemSchema), async (req, res) => {
      const id = req.params.id as string;
      const productId = req.params.productId as string;
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      const { quantity } = req.body as { quantity: number };
      if (quantity > 0) await assertPurchasable(productId, quantity);
      await carts().setLine(id, productId, quantity);
      res.json(await carts().findById(id));
    });

    // حذف سطر: نفس ضبط الكمية إلى 0.
    router.delete("/carts/:id/items/:productId", authenticateOptional, async (req, res) => {
      const id = req.params.id as string;
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      await carts().setLine(id, req.params.productId as string, 0);
      res.json(await carts().findById(id));
    });
  },
};
