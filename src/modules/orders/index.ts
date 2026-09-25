import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { ForbiddenError, NotFoundError } from "../../engine/errors";
import { parsePagination } from "../shared";
import {
  ordersMigrations,
  checkoutSchema,
  quoteSchema,
  statusSchema,
  paymentStatusSchema,
  ORDER_STATUSES,
  type CheckoutInput,
  type QuoteInput,
  type Order,
  type OrderStatus,
  type PaymentStatus,
} from "./orders.schema";
import { OrdersRepository, ORDERS_REPOSITORY } from "./orders.repository";
import { OrdersService, ORDERS_SERVICE } from "./orders.service";

/**
 * Orders - guest AND customer checkout.
 *
 *   POST  /orders                 guest or customer    body { cartId, contactName, contactPhone, shippingAddress }
 *   GET   /orders?status=         owner: all orders; customer: their own
 *   GET   /orders/:id             owner; the customer who placed it; or a guest with ?phone=<the order's phone>
 *   PATCH /orders/:id/status      orders:write (owner)   body { status }
 *   PATCH /orders/:id/payment     orders:write (owner)   body { status, reference? }
 *   GET   /checkout/options       public   -> shipping and payment methods offered by installed plugins
 *   POST  /checkout/quote         cart holder   body { cartId, shippingAddress, shippingMethod? } -> totals
 *
 * Amounts are integers in the smallest currency unit. Shipping and payment
 * methods come from plugins (Plugin/Extension System); with none installed,
 * shipping is free and no payment step runs.
 */
export const ordersModule: CommerceModule = {
  name: "orders",
  migrations: ordersMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional, extensions, logger }) {
    container.register(ORDERS_REPOSITORY, () => new OrdersRepository(pool));
    container.register(ORDERS_SERVICE, () => new OrdersService(pool, accessControl, extensions, logger));
    const orders = () => container.resolve(ORDERS_REPOSITORY);
    const service = () => container.resolve(ORDERS_SERVICE);

    const digits = (phone: string) => phone.replace(/\D/g, "");

    /** Owner sees any order; a customer only theirs; a guest only with the matching phone number. */
    function canView(req: AppRequest, order: Order): boolean {
      if (accessControl.can(req.auth?.role, "orders:read-all")) return true;
      if (req.auth?.role === "customer") return order.customerId !== null && order.customerId === req.auth.userId;
      const phone = req.query.get("phone");
      return phone !== null && digits(phone).length > 0 && digits(phone) === digits(order.contactPhone);
    }

    router.post("/orders", authenticateOptional, validateBody(checkoutSchema), async (req, res) => {
      if (req.auth && !accessControl.can(req.auth.role, "orders:create")) {
        throw new ForbiddenError("Missing permission: orders:create");
      }
      const { order, payment } = await service().checkout(req, req.body as CheckoutInput);
      res.status(201).json({ ...order, payment });
    });

    router.get("/checkout/options", (_req, res) => {
      res.json({
        shippingMethods: extensions.shippingProviders().map((p) => ({ id: p.id, name: p.name })),
        paymentMethods: extensions.paymentProviders().map((p) => ({ id: p.id, name: p.name })),
      });
    });

    router.post("/checkout/quote", authenticateOptional, validateBody(quoteSchema), async (req, res) => {
      res.json(await service().quote(req, req.body as QuoteInput));
    });

    router.get("/orders", authenticate, async (req, res) => {
      const { limit, offset } = parsePagination(req.query);
      const statusParam = req.query.get("status");
      const status = statusParam && (ORDER_STATUSES as readonly string[]).includes(statusParam) ? statusParam : undefined;

      if (accessControl.can(req.auth?.role, "orders:read-all")) {
        res.json(await orders().list({ status, limit, offset }));
        return;
      }
      if (req.auth?.role === "customer" && req.auth.userId && accessControl.can(req.auth.role, "orders:read-own")) {
        res.json(await orders().list({ customerId: req.auth.userId, status, limit, offset }));
        return;
      }
      throw new ForbiddenError("Missing permission: orders:read-own");
    });

    router.get("/orders/:id", authenticateOptional, async (req, res) => {
      const order = await orders().findById(req.params.id as string);
      // 404 (not 403) for someone else's order, so order ids cannot be probed.
      if (!order || !canView(req, order)) throw new NotFoundError("Order not found");
      res.json(order);
    });

    router.patch(
      "/orders/:id/status",
      authenticate,
      requirePermission(accessControl, "orders:write"),
      validateBody(statusSchema),
      async (req, res) => {
        const { status } = req.body as { status: OrderStatus };
        res.json(await service().changeStatus(req.params.id as string, status));
      }
    );

    router.patch(
      "/orders/:id/payment",
      authenticate,
      requirePermission(accessControl, "orders:write"),
      validateBody(paymentStatusSchema),
      async (req, res) => {
        const { status, reference } = req.body as { status: PaymentStatus; reference?: string };
        res.json(await service().setPaymentStatus(req.params.id as string, status, reference));
      }
    );
  },
};
