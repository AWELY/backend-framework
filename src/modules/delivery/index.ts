import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { withMeta } from "../../engine/route-meta";
import { ForbiddenError, NotFoundError } from "../../engine/errors";
import { sendPage, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import { ORDERS_SERVICE } from "../orders/orders.service";
import { ORDERS_REPOSITORY } from "../orders/orders.repository";
import { deliveryMigrations, assignSchema, pickupSchema, deliverSchema, failSchema, deliveryListQuery } from "./delivery.schema";
import { DeliveryRepository, DELIVERY_REPOSITORY } from "./delivery.repository";
import { DeliveryService, DELIVERY_SERVICE } from "./delivery.service";

const ORDER_PARAMS = { orderId: { type: "string", maxLength: 100 } } as const;

/**
 * وحدة التوصيل (جانب المندوب). تعتمد على وحدتي الطلبات والموظفين.
 *
 * المسارات:
 *   POST /orders/:id/delivery          orders:assign: يسند الطلب لمندوب { courierId, note? }
 *   GET  /orders/:id/delivery          التوصيل: للموظفين، وللمندوب المسند، ولصاحب الطلب (أو الضيف بـ ?phone=)
 *   GET  /deliveries                   المندوب: توصيلاته. المدير والمشرف: الكل. ?status= &courierId=
 *   POST /deliveries/:orderId/pickup   المندوب استلم الطلب (الطلب يصبح shipped)
 *   POST /deliveries/:orderId/deliver  سلّمه { cashCollected?, note? } (الطلب delivered، والدفع paid عند التحصيل)
 *   POST /deliveries/:orderId/fail     محاولة فاشلة { note }
 */
export const deliveryModule: CommerceModule = {
  name: "delivery",
  migrations: deliveryMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional, events }) {
    container.register(DELIVERY_REPOSITORY, () => new DeliveryRepository(pool));
    container.register(
      DELIVERY_SERVICE,
      () => new DeliveryService(pool, accessControl, () => container.resolve(ORDERS_SERVICE), events)
    );
    const repo = () => container.resolve(DELIVERY_REPOSITORY);
    const service = () => container.resolve(DELIVERY_SERVICE);
    const digits = (s: string) => s.replace(/\D/g, "");

    /** نفس قاعدة رؤية الطلب، مع المندوب المسند. */
    async function canView(req: AppRequest, orderId: string, courierId: string | null): Promise<boolean> {
      const role = req.auth?.role;
      if (accessControl.can(role, "deliveries:read-all") || accessControl.can(role, "orders:read-all")) return true;
      if (accessControl.can(role, "deliveries:read-own") && req.auth?.userId === courierId) return true;
      const order = await container.resolve(ORDERS_REPOSITORY).findById(orderId);
      if (!order) return false;
      if (req.auth?.principal === "customer") return order.customerId === req.auth.userId;
      const phone = req.query.get("phone");
      return phone !== null && digits(phone).length > 0 && digits(phone) === digits(order.contactPhone);
    }

    router.post(
      "/orders/:id/delivery",
      authenticate,
      requirePermission(accessControl, "orders:assign"),
      withInput({ params: ID_PARAMS, body: assignSchema, summary: "Assign an order to a courier", successStatus: 201 }, async (req, res, { params, body }) => {
        res.status(201).json(await service().assign(req, params.id, body.courierId, body.note));
      })
    );

    router.get(
      "/orders/:id/delivery",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "An order's delivery" }, async (req, res, { params }) => {
        const delivery = await repo().get(params.id);
        if (!delivery || !(await canView(req, params.id, delivery.courierId))) throw new NotFoundError("Delivery not found");
        res.json(delivery);
      })
    );

    router.get(
      "/deliveries",
      authenticate,
      withInput({ query: { ...deliveryListQuery, ...PAGINATION_QUERY }, summary: "List deliveries" }, async (req, res, { query }) => {
        const page = { status: query.status, limit: query.limit ?? 50, offset: query.offset ?? 0 };
        if (accessControl.can(req.auth?.role, "deliveries:read-all")) {
          sendPage(res, await repo().list({ ...page, courierId: query.courierId }));
          return;
        }
        if (accessControl.can(req.auth?.role, "deliveries:read-own") && req.auth?.userId) {
          sendPage(res, await repo().list({ ...page, courierId: req.auth.userId }));
          return;
        }
        throw new ForbiddenError("Missing permission: deliveries:read-own");
      })
    );

    // الصلاحية تُفحص في الخدمة (المندوب المسند، أو deliveries:update-all)؛ البطاقة تصفها لـ OpenAPI.
    router.post(
      "/deliveries/:orderId/pickup",
      authenticate,
      withMeta(withInput({ params: ORDER_PARAMS, body: pickupSchema, summary: "Courier picked the order up" }, async (req, res, { params, body }) => {
        res.json(await service().pickup(req, params.orderId, body.note));
      }), { permission: "deliveries:update-own" })
    );

    // الصلاحية تُفحص في الخدمة (المندوب المسند، أو deliveries:update-all)؛ البطاقة تصفها لـ OpenAPI.
    router.post(
      "/deliveries/:orderId/deliver",
      authenticate,
      withMeta(withInput({ params: ORDER_PARAMS, body: deliverSchema, summary: "Courier delivered the order" }, async (req, res, { params, body }) => {
        res.json(await service().deliver(req, params.orderId, body));
      }), { permission: "deliveries:update-own" })
    );

    // الصلاحية تُفحص في الخدمة (المندوب المسند، أو deliveries:update-all)؛ البطاقة تصفها لـ OpenAPI.
    router.post(
      "/deliveries/:orderId/fail",
      authenticate,
      withMeta(withInput({ params: ORDER_PARAMS, body: failSchema, summary: "A delivery attempt failed" }, async (req, res, { params, body }) => {
        res.json(await service().fail(req, params.orderId, body.note));
      }), { permission: "deliveries:update-own" })
    );
  },
};
