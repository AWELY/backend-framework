import type { CommerceModule } from "../types";
import { withInput } from "../../middleware/validate";
import { ConflictError, ErrorCodes, NotFoundError, TooManyRequestsError, ValidationError } from "../../engine/errors";
import { PRODUCTS_REPOSITORY } from "../products/products.repository";
import { INVENTORY_REPOSITORY } from "../inventory/inventory.repository";
import { cartMigrations, addItemSchema, setItemSchema, lineQuery } from "./cart.schema";
import { CartRepository, CART_REPOSITORY } from "./cart.repository";
import { assertCartAccess, assertCartOpen } from "./cart.access";
import { ID_PARAMS } from "../shared";

const LINE_PARAMS = { id: { type: "string", maxLength: 100 }, productId: { type: "string", maxLength: 100 } } as const;

/** كم يوماً تبقى سلة الضيف المتروكة قبل أن يحذفها التنظيف اليومي. */
const ABANDONED_CART_DAYS = 30;

/**
 * وحدة السلة: للضيف وللزبون المسجل.
 *
 * المسارات:
 *   POST   /carts                         ينشئ سلة (للضيف أو للزبون المسجل). حد اختياري لكل IP
 *   GET    /carts/mine                    الزبون: أحدث سلة مفتوحة له (204 إن لم توجد)
 *   GET    /carts/:id                     السلة مع سطورها
 *   POST   /carts/:id/items               يضيف { productId, variantId?, quantity } (يُجمع مع الموجود)
 *   PUT    /carts/:id/items/:productId    يضبط الكمية { quantity } (0 تحذف). ?variantId= للشكل
 *   DELETE /carts/:id/items/:productId    يحذف السطر. ?variantId= للشكل
 *
 * الإضافة تفحص: المنتج موجود ونشط، والشكل (إن وُجد) يتبعه ونشط، والمنتج ذو الأشكال لا يُضاف
 * دون شكل (VARIANT_REQUIRED)، والمخزون يكفي للكمية الجديدة كلها. الفحص النهائي للمخزون يحدث
 * عند الشراء داخل معاملة (الكمية قد تنفد بين الإضافة والشراء).
 *
 * مهمة يومية (cart.cleanupAbandoned) تحذف سلال الضيوف التي لم تتغير منذ 30 يوماً.
 */
export const cartModule: CommerceModule = {
  name: "cart",
  migrations: cartMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional, limiters, clientIp, jobs }) {
    container.register(CART_REPOSITORY, () => new CartRepository(pool));
    const carts = () => container.resolve(CART_REPOSITORY);
    const products = () => container.resolve(PRODUCTS_REPOSITORY);
    const inventory = () => container.resolve(INVENTORY_REPOSITORY);

    jobs.define("cart.cleanupAbandoned", async (_payload, { logger }) => {
      const deleted = await carts().deleteAbandoned(ABANDONED_CART_DAYS);
      if (deleted > 0) logger.info(`Deleted ${deleted} abandoned guest cart(s)`);
    });
    jobs.schedule("cart.cleanupAbandoned", 24 * 60 * 60 * 1000);

    /** هل يمكن شراء lineQuantity من هذا المنتج (أو الشكل)؟ يرمي الخطأ المناسب إن لا. */
    async function assertPurchasable(productId: string, variantId: string | null, lineQuantity: number): Promise<void> {
      const product = await products().findById(productId);
      if (!product || !product.isActive) throw new NotFoundError("Product not found");
      let available: number;
      if (variantId) {
        const variant = await products().findVariant(productId, variantId);
        if (!variant || !variant.isActive) throw new NotFoundError("Variant not found");
        available = (await inventory().getVariant(variantId)).quantity;
      } else {
        if (await products().hasActiveVariants(productId)) {
          throw new ValidationError(
            "This product has variants: choose one",
            [{ field: "variantId", message: "is required for this product" }],
            ErrorCodes.VARIANT_REQUIRED
          );
        }
        available = (await inventory().get(productId)).quantity;
      }
      if (available < lineQuantity) {
        throw new ConflictError(
          "Insufficient stock",
          { productId, variantId, available, requested: lineQuantity },
          ErrorCodes.INSUFFICIENT_STOCK
        );
      }
    }

    router.post(
      "/carts",
      authenticateOptional,
      withInput({ summary: "Create a cart", successStatus: 201 }, async (req, res) => {
        assertCartAccess(req, { id: "", customerId: null, status: "open" }, accessControl);
        if (limiters.cartCreation) {
          const wait = await limiters.cartCreation.consume(`ip:${clientIp(req)}`);
          if (wait > 0) throw new TooManyRequestsError("Too many carts created from this address. Try again later.", wait);
        }
        const customerId = req.auth?.principal === "customer" ? (req.auth.userId ?? null) : null;
        res.status(201).json(await carts().create(customerId));
      })
    );

    // "لا سلة" ليست خطأ هنا (الزبون اشترى للتو، أو لم يضف شيئاً بعد): 204 بلا جسم، لا 404.
    router.get(
      "/carts/mine",
      authenticate,
      withInput({ summary: "The logged-in customer's open cart (204 when there is none)" }, async (req, res) => {
        if (req.auth?.principal !== "customer" || !req.auth.userId) throw new NotFoundError("Cart not found");
        const cart = await carts().findOpenForCustomer(req.auth.userId);
        if (!cart) {
          res.status(204).end();
          return;
        }
        res.json(cart);
      })
    );

    router.get(
      "/carts/:id",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "Get a cart" }, async (req, res, { params }) => {
        assertCartAccess(req, await carts().findHeader(params.id), accessControl);
        res.json(await carts().findById(params.id));
      })
    );

    router.post(
      "/carts/:id/items",
      authenticateOptional,
      withInput({ params: ID_PARAMS, body: addItemSchema, summary: "Add a product (or variant) to a cart" }, async (req, res, { params, body }) => {
        assertCartOpen(assertCartAccess(req, await carts().findHeader(params.id), accessControl));
        const variantId = body.variantId ?? null;
        const newQuantity = (await carts().quantityOf(params.id, body.productId, variantId)) + body.quantity;
        await assertPurchasable(body.productId, variantId, newQuantity);
        await carts().setLine(params.id, body.productId, newQuantity, variantId);
        res.json(await carts().findById(params.id));
      })
    );

    router.put(
      "/carts/:id/items/:productId",
      authenticateOptional,
      withInput(
        { params: LINE_PARAMS, query: lineQuery, body: setItemSchema, summary: "Set the quantity of a cart line (0 removes it)" },
        async (req, res, { params, query, body }) => {
          assertCartOpen(assertCartAccess(req, await carts().findHeader(params.id), accessControl));
          const variantId = query.variantId ?? null;
          if (body.quantity > 0) await assertPurchasable(params.productId, variantId, body.quantity);
          await carts().setLine(params.id, params.productId, body.quantity, variantId);
          res.json(await carts().findById(params.id));
        }
      )
    );

    router.delete(
      "/carts/:id/items/:productId",
      authenticateOptional,
      withInput({ params: LINE_PARAMS, query: lineQuery, summary: "Remove a cart line" }, async (req, res, { params, query }) => {
        assertCartOpen(assertCartAccess(req, await carts().findHeader(params.id), accessControl));
        await carts().setLine(params.id, params.productId, 0, query.variantId ?? null);
        res.json(await carts().findById(params.id));
      })
    );
  },
};
