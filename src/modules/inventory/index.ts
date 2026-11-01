import type { CommerceModule } from "../types";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { withTransaction } from "../../db/transaction";
import { inventoryMigrations, setStockSchema, adjustStockSchema } from "./inventory.schema";
import { InventoryRepository, INVENTORY_REPOSITORY } from "./inventory.repository";

const PRODUCT_PARAMS = { productId: { type: "string", maxLength: 100 } } as const;
const VARIANT_PARAMS = { variantId: { type: "string", maxLength: 100 } } as const;

/**
 * وحدة المخزون.
 *
 * المسارات:
 *   GET  /inventory/:productId                   عام: الكمية و inStock، ومخزون كل شكل
 *   PUT  /inventory/:productId                   inventory:write، بجسم { quantity }
 *   POST /inventory/:productId/adjust            inventory:write، بجسم { delta }
 *   PUT  /inventory/variants/:variantId          inventory:write، مخزون شكل
 *   POST /inventory/variants/:variantId/adjust   inventory:write
 *
 * كل تغيير بيد المالك أو موظف يطلق حدث inventory.changed (في نفس المعاملة).
 */
export const inventoryModule: CommerceModule = {
  name: "inventory",
  migrations: inventoryMigrations,

  register({ router, container, pool, accessControl, authenticate, events }) {
    container.register(INVENTORY_REPOSITORY, () => new InventoryRepository(pool));
    const repo = () => container.resolve(INVENTORY_REPOSITORY);
    const canWrite = requirePermission(accessControl, "inventory:write");

    /** ينفّذ تغيير مخزون مع حدثه في معاملة واحدة. */
    async function change<T extends { productId: string; quantity: number; variantId?: string }>(
      reason: string,
      work: (inventory: InventoryRepository) => Promise<T>
    ): Promise<T> {
      const result = await withTransaction(pool, async (client) => {
        const level = await work(new InventoryRepository(client));
        await events.publish(client, "inventory.changed", {
          productId: level.productId,
          variantId: level.variantId ?? null,
          quantity: level.quantity,
          reason,
        });
        return level;
      });
      events.notify();
      return result;
    }

    router.get(
      "/inventory/:productId",
      withInput({ params: PRODUCT_PARAMS, summary: "Stock level of a product and its variants" }, async (_req, res, { params }) => {
        res.json(await repo().levels(params.productId));
      })
    );

    router.put(
      "/inventory/:productId",
      authenticate,
      canWrite,
      withInput({ params: PRODUCT_PARAMS, body: setStockSchema, summary: "Set a product's stock" }, async (_req, res, { params, body }) => {
        res.json(await change("set", (inv) => inv.set(params.productId, body.quantity)));
      })
    );

    router.post(
      "/inventory/:productId/adjust",
      authenticate,
      canWrite,
      withInput({ params: PRODUCT_PARAMS, body: adjustStockSchema, summary: "Add to or remove from a product's stock" }, async (_req, res, { params, body }) => {
        res.json(await change("adjust", (inv) => inv.adjust(params.productId, body.delta)));
      })
    );

    router.put(
      "/inventory/variants/:variantId",
      authenticate,
      canWrite,
      withInput({ params: VARIANT_PARAMS, body: setStockSchema, summary: "Set a variant's stock" }, async (_req, res, { params, body }) => {
        res.json(await change("set", (inv) => inv.setVariant(params.variantId, body.quantity)));
      })
    );

    router.post(
      "/inventory/variants/:variantId/adjust",
      authenticate,
      canWrite,
      withInput({ params: VARIANT_PARAMS, body: adjustStockSchema, summary: "Add to or remove from a variant's stock" }, async (_req, res, { params, body }) => {
        res.json(await change("adjust", (inv) => inv.adjustVariant(params.variantId, body.delta)));
      })
    );
  },
};
