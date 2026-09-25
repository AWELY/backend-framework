import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { inventoryMigrations, setStockSchema, adjustStockSchema } from "./inventory.schema";
import { InventoryRepository, INVENTORY_REPOSITORY } from "./inventory.repository";

/**
 * Inventory - deliberately simple (the proposal puts "complex inventory
 * management" out of scope): one quantity per product, no warehouses, batches
 * or reservations.
 *
 *   GET  /inventory/:productId          public   -> { productId, quantity, inStock }
 *   PUT  /inventory/:productId          inventory:write   body { quantity }
 *   POST /inventory/:productId/adjust   inventory:write   body { delta }  (409 if it would go below 0)
 */
export const inventoryModule: CommerceModule = {
  name: "inventory",
  migrations: inventoryMigrations,

  register({ router, container, pool, accessControl, authenticate }) {
    container.register(INVENTORY_REPOSITORY, () => new InventoryRepository(pool));
    const repo = () => container.resolve(INVENTORY_REPOSITORY);
    const canWrite = requirePermission(accessControl, "inventory:write");

    router.get("/inventory/:productId", async (req, res) => {
      res.json(await repo().get(req.params.productId as string));
    });

    router.put("/inventory/:productId", authenticate, canWrite, validateBody(setStockSchema), async (req, res) => {
      const { quantity } = req.body as { quantity: number };
      res.json(await repo().set(req.params.productId as string, quantity));
    });

    router.post(
      "/inventory/:productId/adjust",
      authenticate,
      canWrite,
      validateBody(adjustStockSchema),
      async (req, res) => {
        const { delta } = req.body as { delta: number };
        res.json(await repo().adjust(req.params.productId as string, delta));
      }
    );
  },
};
