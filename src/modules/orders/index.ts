import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { ForbiddenError, NotFoundError, TooManyRequestsError } from "../../engine/errors";
import { actorOf, sendPage, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import {
  ordersMigrations,
  checkoutSchema,
  quoteSchema,
  statusSchema,
  paymentStatusSchema,
  refundSchema,
  orderListQuery,
  type Order,
} from "./orders.schema";
import { OrdersRepository, ORDERS_REPOSITORY } from "./orders.repository";
import { OrdersService, ORDERS_SERVICE } from "./orders.service";
import { OrderTimeline, ORDER_TIMELINE } from "./orders.timeline";

/**
 * وحدة الطلبات: إتمام الشراء للضيف وللزبون المسجل، وإدارة الطلبات للمحل.
 *
 * المسارات:
 *   POST  /orders                 ضيف أو زبون. Idempotency-Key اختياري. حد اختياري لكل IP
 *   GET   /orders                 المالك والموظفون: كل الطلبات. الزبون: طلباته فقط.
 *                                 ?status= &paymentStatus= &q= &limit= &offset=، والعدد في X-Total-Count
 *   GET   /orders/:id             المالك والموظفون، أو الزبون صاحب الطلب، أو ضيف يرسل ?phone=<هاتف الطلب>
 *   GET   /orders/:id/events      سجل الطلب الزمني (لصفحة التتبع)، بنفس قاعدة الرؤية
 *   PATCH /orders/:id/status      orders:write، بجسم { status, note? }
 *   PATCH /orders/:id/payment     orders:write، بجسم { status: pending | paid | failed, reference? }
 *   POST  /orders/:id/refunds     orders:refund، بجسم { amount, reason?, restock? }. Idempotency-Key اختياري
 *   GET   /orders/:id/refunds     orders:read-all
 *   GET   /checkout/options       عام: طرق الشحن والدفع، والعملة، وهل يقبل المتجر كوبونات
 *   POST  /checkout/quote         من يملك السلة: الإجماليات مع الشحن والكوبون، دون إنشاء طلب
 *
 * المبالغ أرقام صحيحة بأصغر وحدة للعملة. طرق الشحن والدفع ومعدّلات السعر تأتي من الإضافات.
 * بلا إضافات: الشحن مجاني، ولا توجد خطوة دفع، ولا كوبونات.
 *
 * مهمة كل دقيقة (orders.releaseExpiredHolds) تلغي الطلبات التي انتهت مهلة دفعها الإلكتروني.
 */
export const ordersModule: CommerceModule = {
  name: "orders",
  migrations: ordersMigrations,

  register({
    router,
    container,
    pool,
    accessControl,
    authenticate,
    authenticateOptional,
    extensions,
    logger,
    events,
    jobs,
    limiters,
    clientIp,
    idempotency,
    currency,
  }) {
    container.register(ORDERS_REPOSITORY, () => new OrdersRepository(pool));
    container.register(ORDER_TIMELINE, () => new OrderTimeline(pool));
    container.register(ORDERS_SERVICE, () => new OrdersService(pool, accessControl, extensions, logger, events, { currency }));
    const orders = () => container.resolve(ORDERS_REPOSITORY);
    const service = () => container.resolve(ORDERS_SERVICE);
    const canWrite = requirePermission(accessControl, "orders:write");

    jobs.define("orders.releaseExpiredHolds", async (_payload, { logger: jobLogger }) => {
      const released = await service().releaseExpiredHolds();
      if (released > 0) jobLogger.info(`Cancelled ${released} order(s) whose payment time ran out`);
    });
    jobs.schedule("orders.releaseExpiredHolds", 60 * 1000);

    const digits = (phone: string) => phone.replace(/\D/g, "");

    /**
     * من يرى الطلب؟
     *   - من يملك orders:read-all (المالك والموظفون): أي طلب.
     *   - الزبون: طلباته فقط.
     *   - الضيف: فقط إن أرسل رقم الهاتف المسجل في الطلب (?phone=)، مع رقم الطلب نفسه.
     * رقم الطلب UUID لا يُخمَّن، والهاتف شرط ثانٍ، فلا يستطيع أحد رؤية طلبات غيره.
     */
    function canView(req: AppRequest, order: Order): boolean {
      if (accessControl.can(req.auth?.role, "orders:read-all")) return true;
      if (req.auth?.principal === "customer") return order.customerId !== null && order.customerId === req.auth.userId;
      const phone = req.query.get("phone");
      return phone !== null && digits(phone).length > 0 && digits(phone) === digits(order.contactPhone);
    }

    /** الطلب إن كان مرئياً للمرسل، وإلا 404 (لا نكشف حتى أن الطلب موجود). */
    async function visibleOrder(req: AppRequest, id: string): Promise<Order> {
      const order = await orders().findById(id);
      if (!order || !canView(req, order)) throw new NotFoundError("Order not found");
      return order;
    }

    router.post(
      "/orders",
      authenticateOptional,
      idempotency,
      withInput({ body: checkoutSchema, summary: "Check out a cart (Idempotency-Key supported)", successStatus: 201 }, async (req, res, { body }) => {
        if (req.auth && !accessControl.can(req.auth.role, "orders:create")) {
          throw new ForbiddenError("Missing permission: orders:create");
        }
        if (limiters.checkout) {
          const wait = await limiters.checkout.consume(`ip:${clientIp(req)}`);
          if (wait > 0) throw new TooManyRequestsError("Too many orders from this address. Try again later.", wait);
        }
        const { order, payment } = await service().checkout(req, body);
        res.status(201).json({ ...order, payment });
      })
    );

    router.get(
      "/checkout/options",
      withInput({ summary: "Shipping and payment methods, currency and coupon support" }, (_req, res) => {
        res.json({
          currency,
          couponsEnabled: extensions.priceAdjusters().length > 0,
          shippingMethods: extensions
            .shippingProviders()
            .map((p) => ({ id: p.id, name: p.name, ...(p.cities ? { cities: p.cities } : {}) })),
          paymentMethods: extensions.paymentProviders().map((p) => ({ id: p.id, name: p.name })),
        });
      })
    );

    router.post(
      "/checkout/quote",
      authenticateOptional,
      withInput({ body: quoteSchema, summary: "Price a cart with shipping and coupon, without ordering" }, async (req, res, { body }) => {
        res.json(await service().quote(req, body));
      })
    );

    router.get(
      "/orders",
      authenticate,
      withInput({ query: { ...orderListQuery, ...PAGINATION_QUERY }, summary: "List orders" }, async (req, res, { query }) => {
        const filter = { status: query.status, paymentStatus: query.paymentStatus, limit: query.limit ?? 50, offset: query.offset ?? 0 };
        if (accessControl.can(req.auth?.role, "orders:read-all")) {
          sendPage(res, await orders().listPage({ ...filter, q: query.q }));
          return;
        }
        if (req.auth?.principal === "customer" && req.auth.userId && accessControl.can(req.auth.role, "orders:read-own")) {
          sendPage(res, await orders().listPage({ ...filter, customerId: req.auth.userId }));
          return;
        }
        throw new ForbiddenError("Missing permission: orders:read-own");
      })
    );

    router.get(
      "/orders/:id",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "Get an order" }, async (req, res, { params }) => {
        res.json(await visibleOrder(req, params.id));
      })
    );

    router.get(
      "/orders/:id/events",
      authenticateOptional,
      withInput({ params: ID_PARAMS, summary: "An order's timeline" }, async (req, res, { params }) => {
        await visibleOrder(req, params.id);
        res.json(await service().timeline(params.id));
      })
    );

    router.patch(
      "/orders/:id/status",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, body: statusSchema, summary: "Change an order's status" }, async (req, res, { params, body }) => {
        res.json(await service().changeStatus(params.id, body.status, actorOf(req), { note: body.note }));
      })
    );

    router.patch(
      "/orders/:id/payment",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, body: paymentStatusSchema, summary: "Record a payment result" }, async (req, res, { params, body }) => {
        res.json(await service().setPaymentStatus(params.id, body.status, body.reference, actorOf(req)));
      })
    );

    router.post(
      "/orders/:id/refunds",
      authenticate,
      requirePermission(accessControl, "orders:refund"),
      idempotency,
      withInput({ params: ID_PARAMS, body: refundSchema, summary: "Refund an amount, optionally restocking items", successStatus: 201 }, async (req, res, { params, body }) => {
        res.status(201).json(await service().refund(params.id, body, actorOf(req)));
      })
    );

    router.get(
      "/orders/:id/refunds",
      authenticate,
      requirePermission(accessControl, "orders:read-all"),
      withInput({ params: ID_PARAMS, summary: "List an order's refunds" }, async (_req, res, { params }) => {
        res.json(await service().refunds(params.id));
      })
    );
  },
};
