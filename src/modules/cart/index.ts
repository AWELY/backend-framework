import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { ConflictError, NotFoundError } from "../../engine/errors";
import { PRODUCTS_REPOSITORY } from "../products/products.repository";
import { INVENTORY_REPOSITORY } from "../inventory/inventory.repository";
import { cartMigrations, addItemSchema, setItemSchema } from "./cart.schema";
import { CartRepository, CART_REPOSITORY } from "./cart.repository";
import { assertCartAccess, assertCartOpen } from "./cart.access";

/**
 * Shopping cart - works for guests AND logged-in customers.
 *
 *   POST   /carts                           create (attached to the customer if logged in)
 *   GET    /carts/:id
 *   POST   /carts/:id/items                 body { productId, quantity }  adds to the line
 *   PUT    /carts/:id/items/:productId      body { quantity }  sets the line (0 removes)
 *   DELETE /carts/:id/items/:productId
 *
 * Stock is CHECKED when adding (fast feedback) but only RESERVED at checkout
 * (Orders module), inside the same transaction that creates the order.
 * Depends on Products and Inventory (registered earlier).
 */
export const cartModule: CommerceModule = {
  name: "cart",
  migrations: cartMigrations,

  register({ router, container, pool, accessControl, authenticateOptional }) {
    container.register(CART_REPOSITORY, () => new CartRepository(pool));
    const carts = () => container.resolve(CART_REPOSITORY);
    const products = () => container.resolve(PRODUCTS_REPOSITORY);
    const inventory = () => container.resolve(INVENTORY_REPOSITORY);

    /** Product must exist, be for sale, and have enough stock for the new line quantity. */
    async function assertPurchasable(productId: string, lineQuantity: number): Promise<void> {
      const product = await products().findById(productId);
      if (!product || !product.isActive) throw new NotFoundError("Product not found");
      const stock = await inventory().get(productId);
      if (stock.quantity < lineQuantity) {
        throw new ConflictError("Insufficient stock", { productId, available: stock.quantity, requested: lineQuantity });
      }
    }

    router.post("/carts", authenticateOptional, async (req, res) => {
      assertCartAccess(req, { id: "", customerId: null, status: "open" }, accessControl);
      const customerId = req.auth?.role === "customer" ? (req.auth.userId ?? null) : null;
      res.status(201).json(await carts().create(customerId));
    });

    router.get("/carts/:id", authenticateOptional, async (req, res) => {
      const id = req.params.id as string;
      assertCartAccess(req, await carts().findHeader(id), accessControl);
      res.json(await carts().findById(id));
    });

    router.post("/carts/:id/items", authenticateOptional, validateBody(addItemSchema), async (req, res) => {
      const id = req.params.id as string;
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      const { productId, quantity } = req.body as { productId: string; quantity: number };
      const newQuantity = (await carts().quantityOf(id, productId)) + quantity;
      await assertPurchasable(productId, newQuantity);
      await carts().setLine(id, productId, newQuantity);
      res.json(await carts().findById(id));
    });

    router.put("/carts/:id/items/:productId", authenticateOptional, validateBody(setItemSchema), async (req, res) => {
      const id = req.params.id as string;
      const productId = req.params.productId as string;
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      const { quantity } = req.body as { quantity: number };
      if (quantity > 0) await assertPurchasable(productId, quantity);
      await carts().setLine(id, productId, quantity);
      res.json(await carts().findById(id));
    });

    router.delete("/carts/:id/items/:productId", authenticateOptional, async (req, res) => {
      const id = req.params.id as string;
      assertCartOpen(assertCartAccess(req, await carts().findHeader(id), accessControl));
      await carts().setLine(id, req.params.productId as string, 0);
      res.json(await carts().findById(id));
    });
  },
};
