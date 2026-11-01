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
 * وحدة الطلبات: إتمام الشراء للضيف وللزبون المسجل.
 *
 * المسارات:
 *   POST  /orders                 ضيف أو زبون. الجسم { cartId, contactName, contactPhone, shippingAddress, ... }
 *   GET   /orders?status=         المالك: كل الطلبات. الزبون: طلباته فقط
 *   GET   /orders/:id             المالك، أو الزبون صاحب الطلب، أو ضيف يرسل ?phone=<هاتف الطلب>
 *   PATCH /orders/:id/status      orders:write (المالك)، بجسم { status }
 *   PATCH /orders/:id/payment     orders:write (المالك)، بجسم { status, reference? }
 *   GET   /checkout/options       عام: طرق الشحن والدفع التي تقدمها الإضافات المثبتة
 *   POST  /checkout/quote         من يملك السلة. الجسم { cartId, shippingAddress, shippingCity?, shippingMethod? }،
 *                                 والرد الإجماليات
 *
 * المبالغ أرقام صحيحة بأصغر وحدة للعملة (الدرهم). طرق الشحن والدفع تأتي من الإضافات
 * (نظام التوسعة). بلا إضافات: الشحن مجاني، ولا توجد خطوة دفع.
 *
 * المنطق المعقد (إتمام الشراء، وتغيير الحالة، والدفع) في orders.service.ts، وهذا الملف
 * يربطه بالمسارات ويفحص من يحق له ماذا.
 */
export const ordersModule: CommerceModule = {
  name: "orders",
  migrations: ordersMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional, extensions, logger }) {
    container.register(ORDERS_REPOSITORY, () => new OrdersRepository(pool));
    // الخدمة تحتاج أدوات أكثر: المجموعة، والصلاحيات، والإضافات، والسجل.
    container.register(ORDERS_SERVICE, () => new OrdersService(pool, accessControl, extensions, logger));
    const orders = () => container.resolve(ORDERS_REPOSITORY);
    const service = () => container.resolve(ORDERS_SERVICE);

    // يحذف كل ما ليس رقماً: "+218 91-234 5678" يصبح "218912345678". يسمح بمقارنة هاتفين
    // كُتبا بأشكال مختلفة.
    const digits = (phone: string) => phone.replace(/\D/g, "");

    /**
     * من يرى الطلب؟
     *   - المالك: أي طلب (صلاحية orders:read-all، وعنده "*").
     *   - الزبون: طلباته فقط.
     *   - الضيف: فقط إن أرسل رقم الهاتف المسجل في الطلب (?phone=)، مع رقم الطلب نفسه.
     * رقم الطلب UUID لا يُخمَّن، والهاتف شرط ثانٍ، فلا يستطيع أحد رؤية طلبات غيره.
     */
    function canView(req: AppRequest, order: Order): boolean {
      if (accessControl.can(req.auth?.role, "orders:read-all")) return true;
      if (req.auth?.role === "customer") return order.customerId !== null && order.customerId === req.auth.userId;
      const phone = req.query.get("phone");
      return phone !== null && digits(phone).length > 0 && digits(phone) === digits(order.contactPhone);
    }

    // إتمام الشراء. الضيف مسموح (authenticateOptional). المرسل المعروف يجب أن يملك orders:create.
    // الرد 201 بالطلب ومعه نتيجة الدفع (تعليمات الدفع عند الاستلام مثلاً).
    router.post("/orders", authenticateOptional, validateBody(checkoutSchema), async (req, res) => {
      if (req.auth && !accessControl.can(req.auth.role, "orders:create")) {
        throw new ForbiddenError("Missing permission: orders:create");
      }
      const { order, payment } = await service().checkout(req, req.body as CheckoutInput);
      // "...order" تنسخ كل حقول الطلب إلى الرد، ثم نضيف payment.
      res.status(201).json({ ...order, payment });
    });

    // ما تعرضه صفحة إتمام الشراء: طرق الشحن (ومدنها إن وُجدت) وطرق الدفع من الإضافات.
    // "...(شرط ? { cities } : {})" تضيف الحقل cities فقط إن كانت للطريقة قائمة مدن.
    router.get("/checkout/options", (_req, res) => {
      res.json({
        shippingMethods: extensions
          .shippingProviders()
          .map((p) => ({ id: p.id, name: p.name, ...(p.cities ? { cities: p.cities } : {}) })),
        paymentMethods: extensions.paymentProviders().map((p) => ({ id: p.id, name: p.name })),
      });
    });

    // التسعير قبل الشراء (بلا أي أثر جانبي).
    router.post("/checkout/quote", authenticateOptional, validateBody(quoteSchema), async (req, res) => {
      res.json(await service().quote(req, req.body as QuoteInput));
    });

    // قائمة الطلبات. يتطلب دخولاً. الحالة في ?status= تُقبل فقط إن كانت من الحالات الخمس،
    // وإلا تُتجاهل.
    router.get("/orders", authenticate, async (req, res) => {
      const { limit, offset } = parsePagination(req.query);
      const statusParam = req.query.get("status");
      const status = statusParam && (ORDER_STATUSES as readonly string[]).includes(statusParam) ? statusParam : undefined;

      // المالك: كل الطلبات.
      if (accessControl.can(req.auth?.role, "orders:read-all")) {
        res.json(await orders().list({ status, limit, offset }));
        return;
      }
      // الزبون: طلباته فقط، والتصفية برقمه من التوكن، لا من الطلب.
      if (req.auth?.role === "customer" && req.auth.userId && accessControl.can(req.auth.role, "orders:read-own")) {
        res.json(await orders().list({ customerId: req.auth.userId, status, limit, offset }));
        return;
      }
      throw new ForbiddenError("Missing permission: orders:read-own");
    });

    // طلب واحد (صفحة تتبع الطلب في الموقع تستخدمه).
    router.get("/orders/:id", authenticateOptional, async (req, res) => {
      const order = await orders().findById(req.params.id as string);
      // 404 وليس 403 لطلب شخص آخر، فلا يمكن اختبار أرقام الطلبات لمعرفة الموجود منها.
      if (!order || !canView(req, order)) throw new NotFoundError("Order not found");
      res.json(order);
    });

    // المالك يغيّر حالة الطلب (يؤكده، يشحنه، يسلمه، يلغيه).
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

    // المالك يسجل الدفع، مثلاً "paid" بعد استلام النقود من المندوب.
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
