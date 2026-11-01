import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { inventoryMigrations, setStockSchema, adjustStockSchema } from "./inventory.schema";
import { InventoryRepository, INVENTORY_REPOSITORY } from "./inventory.repository";

/**
 * وحدة المخزون. بسيطة عمداً، لأن المقترح يضع "إدارة المخزون المعقدة" خارج النطاق:
 * كمية واحدة لكل منتج، دون مستودعات متعددة، ولا دفعات، ولا حجز مؤقت.
 *
 * المسارات:
 *   GET  /inventory/:productId          عام، ويرد بـ { productId, quantity, inStock }
 *   PUT  /inventory/:productId          inventory:write، بجسم { quantity }: ضبط الكمية إلى رقم
 *   POST /inventory/:productId/adjust   inventory:write، بجسم { delta }: زيادة أو إنقاص
 *                                       (409 إن كانت النتيجة ستصبح أقل من صفر)
 *
 * الفرق بين PUT و adjust:
 *   PUT    { "quantity": 20 }  "عندي الآن 20 قطعة" (بعد جرد مثلاً).
 *   adjust { "delta": 5 }      "وصلتني 5 قطع إضافية"، و { "delta": -2 } "تلفت قطعتان".
 */
export const inventoryModule: CommerceModule = {
  name: "inventory",
  migrations: inventoryMigrations,

  register({ router, container, pool, accessControl, authenticate }) {
    container.register(INVENTORY_REPOSITORY, () => new InventoryRepository(pool));
    const repo = () => container.resolve(INVENTORY_REPOSITORY);
    const canWrite = requirePermission(accessControl, "inventory:write");

    // كمية منتج. عام لأن الموقع يعرض "متوفر" أو "نفد" لكل منتج.
    router.get("/inventory/:productId", async (req, res) => {
      res.json(await repo().get(req.params.productId as string));
    });

    // ضبط الكمية إلى رقم محدد (المالك فقط).
    router.put("/inventory/:productId", authenticate, canWrite, validateBody(setStockSchema), async (req, res) => {
      const { quantity } = req.body as { quantity: number };
      res.json(await repo().set(req.params.productId as string, quantity));
    });

    // زيادة أو إنقاص بمقدار delta (المالك فقط).
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
