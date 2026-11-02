import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AppRequest } from "../../engine/http/request";
import type { AccessControl } from "../../engine/access-control";
import type { Logger } from "../../engine/logger";
import { BadGatewayError, ConflictError, ErrorCodes, NotFoundError, ValidationError } from "../../engine/errors";
import { withTransaction } from "../../db/transaction";
import { translateDbError } from "../../db/errors";
import type { Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import { InventoryRepository, byStockLockOrder } from "../inventory/inventory.repository";
import { assertCartAccess, assertCartOpen } from "../cart/cart.access";
import type { CartHeader } from "../cart/cart.schema";
import type {
  ExtensionRegistry,
  PaymentProvider,
  PaymentResult,
  PriceAdjustment,
  ShippingProvider,
} from "../extensions";
import type { EventPublisher } from "../types";
import { actorOf, SYSTEM_ACTOR, type Actor } from "../shared";
import { OrdersRepository } from "./orders.repository";
import { OrderTimeline } from "./orders.timeline";
import {
  PAYMENT_TRANSITIONS,
  STATUS_TRANSITIONS,
  type CheckoutInput,
  type QuoteInput,
  type Order,
  type OrderEvent,
  type OrderStatus,
  type PaymentStatus,
  type Refund,
  type RefundInput,
  type RestockLine,
} from "./orders.schema";

/** سطر سلة مع بيانات منتجه (أو شكله) الحالية، كما يُقرأ عند التسعير والشراء. */
interface Line {
  productId: string;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  name: string;
  variantTitle: string | null;
  price: number;
  isActive: boolean;
}

interface LineRow {
  product_id: string;
  variant_id: string | null;
  sku: string | null;
  quantity: number;
  name: string;
  variant_title: string | null;
  price: number;
  is_active: boolean;
}

/** ينفّذ استعلاماً على المجموعة أو على اتصال معاملة، ويترجم أخطاء القاعدة إلى أخطاء HTTP. */
async function query<R extends QueryResultRow>(db: Queryable, text: string, values: unknown[]) {
  try {
    return await db.query<R>(text, values);
  } catch (err) {
    throw translateDbError(err);
  }
}

/** تسعير السلة: مجموع المنتجات، والشحن، وتعديلات السعر، والإجمالي. */
export interface Quote {
  currency: string;
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  adjustments: PriceAdjustment[];
  adjustmentsTotal: number;
  total: number;
}

/** نتيجة إتمام الشراء: الطلب، وما قالته إضافة الدفع. */
export interface CheckoutResult {
  order: Order;
  /** ما ردت به إضافة الدفع (تعليمات أو رابط تحويل)، أو null إن لم يكن للمتجر إضافة دفع. */
  payment: PaymentResult | null;
}

const PAYMENT_RESULT_STATUSES = new Set(["pending", "paid", "failed"]);

/**
 * خدمة الطلبات: العمليات التي تتكون من عدة خطوات، وكل عملية في معاملة واحدة
 * (إما أن تحدث كل الخطوات، وإما لا شيء).
 *
 * لماذا "خدمة" (Service) منفصلة عن المستودع؟ المستودع يقرأ ويكتب جدولاً واحداً فقط.
 * أما إتمام الشراء فينسّق بين عدة أشياء: السلة، والمخزون، والطلبات، وإضافات الشحن والدفع
 * والتسعير، والأحداث. هذا "منطق العمل" (Business logic)، ومكانه الخدمة.
 *
 * قواعد التوقيت:
 *   1. الشحن وتعديلات السعر تُحسب داخل معاملة الشراء، لأنها جزء من الطلب نفسه.
 *   2. الدفع يبدأ فقط بعد COMMIT: بوابة دفع بطيئة أو معطوبة يجب ألا تُبقي أقفال القاعدة
 *      مفتوحة، ولا أن تلغي طلباً صحيحاً.
 *   3. الأحداث تُكتب في صندوق الصادر داخل نفس المعاملة، فلا يضيع حدث ولا يُطلق حدث لتغيير أُلغي.
 *   4. أقفال المخزون دائماً بنفس الترتيب (byStockLockOrder)، فلا يحدث Deadlock بين شراءين.
 */
export class OrdersService {
  private readonly timelineRepo: OrderTimeline;

  constructor(
    private readonly pool: Pool,
    private readonly accessControl: AccessControl,
    private readonly extensions: ExtensionRegistry,
    private readonly logger: Logger,
    private readonly events: EventPublisher,
    private readonly options: { currency: string } = { currency: "LYD" }
  ) {
    this.timelineRepo = new OrderTimeline(pool);
  }

  /**
   * يحوّل معرّف طريقة الشحن المرسل من الموقع إلى المزود المسجل.
   *   - المتجر بلا إضافات شحن: لا شحن (null). وإرسال طريقة شحن عندها خطأ 400.
   *   - المتجر فيه إضافات شحن: الطريقة مطلوبة، ويجب أن تكون من المسجلة، وإلا 400 بقائمة المتاح.
   */
  private resolveShipping(method: string | undefined): ShippingProvider | null {
    const available = this.extensions.shippingProviders().map((p) => p.id);
    if (available.length === 0) {
      if (method) throw new ValidationError("This store has no shipping methods", [{ field: "shippingMethod", message: "is not an allowed field" }]);
      return null;
    }
    const provider = method ? this.extensions.shippingProvider(method) : undefined;
    if (!provider) {
      throw new ValidationError("Validation failed", [
        { field: "shippingMethod", message: `must be one of: ${available.join(", ")}` },
      ]);
    }
    return provider;
  }

  /** نفس منطق resolveShipping، لطرق الدفع. */
  private resolvePayment(method: string | undefined): PaymentProvider | null {
    const available = this.extensions.paymentProviders().map((p) => p.id);
    if (available.length === 0) {
      if (method) throw new ValidationError("This store has no payment methods", [{ field: "paymentMethod", message: "is not an allowed field" }]);
      return null;
    }
    const provider = method ? this.extensions.paymentProvider(method) : undefined;
    if (!provider) {
      throw new ValidationError("Validation failed", [
        { field: "paymentMethod", message: `must be one of: ${available.join(", ")}` },
      ]);
    }
    return provider;
  }

  /** سطور السلة بالأسعار الحالية (سعر الشكل إن وُجد، وإلا سعر المنتج)، بترتيب الإضافة. */
  private async loadLines(db: Queryable, cartId: string): Promise<Line[]> {
    const { rows } = await query<LineRow>(
      db,
      `SELECT ci.product_id, ci.variant_id, v.sku, ci.quantity, p.name, v.title AS variant_title,
              COALESCE(v.price, p.price) AS price,
              (p.is_active AND (v.id IS NULL OR v.is_active)) AS is_active
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         LEFT JOIN product_variants v ON v.id = ci.variant_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [cartId]
    );
    return rows.map((r) => ({
      productId: r.product_id,
      variantId: r.variant_id,
      sku: r.sku,
      quantity: r.quantity,
      name: r.name,
      variantTitle: r.variant_title,
      price: r.price,
      isActive: r.is_active,
    }));
  }

  /**
   * يسعّر سطوراً: المجموع، ثم الشحن من إضافته، ثم معدّلات السعر بالترتيب (كل معدّل يرى ما أضافه
   * من قبله). نتأكد من ردود الإضافات: رقم صحيح غير سالب، والإجمالي لا يصبح سالباً. إضافة ترد
   * بقيمة خاطئة خطأ برمجي فيها، فنرمي Error عادياً (500) وتُلغى المعاملة كاملة.
   */
  private async price(
    lines: Line[],
    shipping: ShippingProvider | null,
    input: { shippingAddress: string; shippingCity?: string; couponCode?: string },
    customerId: string | null
  ): Promise<Quote> {
    const items = lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: l.price }));
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    let shippingCost = 0;
    if (shipping) {
      shippingCost = await shipping.quote({
        items: items.map(({ productId, quantity, unitPrice }) => ({ productId, quantity, unitPrice })),
        subtotal,
        shippingAddress: input.shippingAddress,
        shippingCity: input.shippingCity,
      });
      if (!Number.isInteger(shippingCost) || shippingCost < 0) {
        throw new Error(`Shipping provider '${shipping.id}' returned an invalid cost: ${shippingCost}`);
      }
    }

    const adjusters = this.extensions.priceAdjusters();
    if (input.couponCode && adjusters.length === 0) {
      throw new ValidationError("This store does not accept coupons", [{ field: "couponCode", message: "is not supported" }]);
    }
    const adjustments: PriceAdjustment[] = [];
    for (const adjuster of adjusters) {
      const result = await adjuster.adjust({
        items,
        subtotal,
        shippingMethod: shipping?.id ?? null,
        shippingCost,
        shippingCity: input.shippingCity,
        couponCode: input.couponCode,
        customerId,
        currency: this.options.currency,
        adjustments: [...adjustments],
      });
      for (const a of result) {
        if (!Number.isInteger(a.amount) || a.amount < 0 || !["discount", "tax", "fee"].includes(a.type) || !a.code || !a.label) {
          throw new Error(`Price adjuster '${adjuster.id}' returned an invalid adjustment: ${JSON.stringify(a)}`);
        }
        adjustments.push({ code: a.code, label: a.label, type: a.type, amount: a.amount, source: adjuster.id });
      }
    }
    const adjustmentsTotal = adjustments.reduce((sum, a) => sum + (a.type === "discount" ? -a.amount : a.amount), 0);
    const total = subtotal + shippingCost + adjustmentsTotal;
    if (total < 0) throw new Error("Price adjusters produced a negative total");
    return {
      currency: this.options.currency,
      subtotal,
      shippingMethod: shipping?.id ?? null,
      shippingCost,
      adjustments,
      adjustmentsTotal,
      total,
    };
  }

  /** يقرأ رأس السلة ويتحقق أن المرسل يملكها. forUpdate يقفلها حتى نهاية المعاملة. */
  private async cartFor(db: Queryable, req: AppRequest, cartId: string, forUpdate: boolean): Promise<CartHeader> {
    const { rows } = await query<{ id: string; customer_id: string | null; status: CartHeader["status"] }>(
      db,
      `SELECT id, customer_id, status FROM carts WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [cartId]
    );
    const row = rows[0];
    return assertCartAccess(req, row ? { id: row.id, customerId: row.customer_id, status: row.status } : null, this.accessControl);
  }

  /** رقم الزبون الداخل، إن كان المرسل زبوناً. */
  private customerOf(req: AppRequest): string | null {
    return req.auth?.principal === "customer" ? (req.auth.userId ?? null) : null;
  }

  /**
   * يسعّر السلة مع طريقة شحن وكوبون قبل الشراء، دون أي أثر جانبي: لا يغيّر مخزوناً، ولا ينشئ طلباً.
   * يستخدمه الموقع ليعرض الإجمالي عند اختيار المدينة أو إدخال كوبون (POST /checkout/quote).
   * المنتجات غير المتاحة لا تُحسب.
   */
  async quote(req: AppRequest, input: QuoteInput): Promise<Quote> {
    const cart = await this.cartFor(this.pool, req, input.cartId, false);
    const lines = (await this.loadLines(this.pool, cart.id)).filter((l) => l.isActive);
    const shipping = this.resolveShipping(input.shippingMethod);
    return this.price(lines, shipping, input, cart.customerId ?? this.customerOf(req));
  }

  /**
   * إتمام الشراء: تحويل السلة إلى طلب. أهم عملية في الإطار.
   *
   * داخل معاملة واحدة:
   *   1. قفل صف السلة (SELECT ... FOR UPDATE): لو ضغط المشتري "تأكيد الطلب" مرتين بسرعة،
   *      تنتظر المعاملة الثانية حتى تنتهي الأولى، ثم تجد السلة "checked_out" فتحصل على 409.
   *      (ومع ترويسة Idempotency-Key يحصل على الطلب نفسه بدل 409.)
   *   2. التحقق: يحق لك هذه السلة؟ ما زالت مفتوحة؟ ليست فارغة؟ كل منتجاتها ما زالت متاحة؟
   *   3. التسعير: الشحن ومعدّلات السعر (كوبون غير صالح يوقف كل شيء قبل لمس المخزون).
   *   4. إنقاص المخزون لكل سطر بتحديث ذري، بترتيب أقفال ثابت. إن نقص سطر واحد، تُلغى
   *      المعاملة كاملة (ROLLBACK)، فلا يُباع شيء أبداً، ولا يبقى مخزون ناقص بلا طلب.
   *   5. إنشاء الطلب مع نسخ اسم كل منتج وسعره إلى order_items (صورة ثابتة وقت الشراء).
   *   6. سطر "أُنشئ" في سجل الطلب الزمني، وحدث order.created في صندوق الصادر.
   *   7. تعليم السلة "checked_out".
   * بعد COMMIT:
   *   8. بدء الدفع عبر إضافة الدفع، ثم تسجيل نتيجته (وحدث order.paymentChanged). فشل الإضافة
   *      يُسجَّل، ويُحفظ الطلب بحالة دفع "failed"، ولا يُلغى. إن كان للإضافة holdSeconds، يُلغى
   *      الطلب غير المدفوع تلقائياً بعد المهلة ويعود مخزونه.
   */
  async checkout(req: AppRequest, input: CheckoutInput): Promise<CheckoutResult> {
    const shipping = this.resolveShipping(input.shippingMethod);
    const paymentProvider = this.resolvePayment(input.paymentMethod);
    const actor = actorOf(req);

    const orderId = await withTransaction(this.pool, async (client) => {
      const cart = await this.cartFor(client, req, input.cartId, true);
      assertCartOpen(cart);

      const lines = await this.loadLines(client, cart.id);
      if (lines.length === 0) throw new ValidationError("The cart is empty", undefined, ErrorCodes.CART_EMPTY);
      const unavailable = lines.filter((l) => !l.isActive);
      if (unavailable.length > 0) {
        throw new ConflictError(
          "Some products in the cart are no longer available",
          { productIds: unavailable.map((l) => l.productId), variantIds: unavailable.map((l) => l.variantId).filter(Boolean) },
          ErrorCodes.PRODUCT_UNAVAILABLE
        );
      }

      const customerId = cart.customerId ?? this.customerOf(req);
      const pricing = await this.price(lines, shipping, input, customerId);

      const inventory = new InventoryRepository(client);
      for (const line of [...lines].sort(byStockLockOrder)) await inventory.adjustLine(line, -line.quantity);

      const repo = new OrdersRepository(client);
      const id = await repo.insert({
        customerId,
        cartId: cart.id,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        shippingAddress: input.shippingAddress,
        shippingCity: input.shippingCity ?? null,
        currency: pricing.currency,
        subtotal: pricing.subtotal,
        shippingMethod: pricing.shippingMethod,
        shippingCost: pricing.shippingCost,
        adjustments: pricing.adjustments,
        adjustmentsTotal: pricing.adjustmentsTotal,
        paymentMethod: paymentProvider?.id ?? null,
        items: lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          sku: l.sku,
          productName: l.name,
          variantTitle: l.variantTitle,
          unitPrice: l.price,
          quantity: l.quantity,
          lineTotal: l.price * l.quantity,
        })),
      });
      // مهلة الدفع تبدأ مع الطلب نفسه: لو توقف الخادم قبل بدء الدفع، يُلغى الطلب بعد المهلة ويعود
      // مخزونه، بدل أن يبقى محجوزاً للأبد بلا دفع.
      if (paymentProvider?.holdSeconds) {
        await query(client, "UPDATE orders SET payment_expires_at = now() + make_interval(secs => $2) WHERE id = $1", [
          id,
          paymentProvider.holdSeconds,
        ]);
      }
      await this.timelineRepo.record(id, { type: "created", to: "pending", actor }, client);
      await query(client, "UPDATE carts SET status = 'checked_out', updated_at = now() WHERE id = $1", [cart.id]);
      await this.events.publish(client, "order.created", { order: (await repo.findById(id)) as Order });
      return id;
    });
    this.events.notify();

    const orders = new OrdersRepository(this.pool);
    let payment: PaymentResult | null = null;
    if (paymentProvider) {
      try {
        payment = await paymentProvider.initiate((await orders.findById(orderId)) as Order);
        if (!payment || !PAYMENT_RESULT_STATUSES.has(payment.status)) {
          throw new Error(`returned an invalid status: ${JSON.stringify(payment?.status)}`);
        }
      } catch (err) {
        this.logger.error(`Payment provider '${paymentProvider.id}' failed to start payment`, {
          orderId,
          message: err instanceof Error ? err.message : String(err),
        });
        payment = { status: "failed" };
      }
      const result = payment;
      const hold = result.status === "paid" ? null : paymentProvider.holdSeconds;
      await withTransaction(this.pool, (client) =>
        this.applyPayment(client, orderId, result.status, result.reference, SYSTEM_ACTOR, hold)
      );
      this.events.notify();
    }

    return { order: (await orders.findById(orderId)) as Order, payment };
  }

  /**
   * يغيّر حالة الطلب داخل معاملة قائمة (client)، حسب STATUS_TRANSITIONS. تستخدمه changeStatus،
   * ووحدة التوصيل (الاستلام يجعله shipped، والتسليم delivered) داخل معاملتها هي.
   * الإلغاء يعيد إلى المخزون ما لم يُعد منه بعد، بترتيب الأقفال الثابت.
   */
  async applyStatus(
    client: PoolClient,
    orderId: string,
    next: OrderStatus,
    actor: Actor,
    options: { reason?: string; note?: string } = {}
  ): Promise<{ order: Order; from: OrderStatus }> {
    const repo = new OrdersRepository(client);
    const current = await repo.findById(orderId, { forUpdate: true });
    if (!current) throw new NotFoundError("Order not found");
    if (!STATUS_TRANSITIONS[current.status].includes(next)) {
      throw new ConflictError(
        `Cannot change an order from '${current.status}' to '${next}'`,
        { allowed: STATUS_TRANSITIONS[current.status] },
        ErrorCodes.INVALID_STATUS_TRANSITION
      );
    }
    if (next === "cancelled") {
      const inventory = new InventoryRepository(client);
      const lines = current.items
        .filter((i): i is typeof i & { productId: string } => i.productId !== null && i.quantity > i.restockedQuantity)
        .map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity - i.restockedQuantity }))
        .sort(byStockLockOrder);
      for (const line of lines) {
        await inventory.adjustLine(line, line.quantity).catch((err: unknown) => {
          // المنتج أو الشكل حُذف بعد الطلب: لا مخزون نعيده إليه، والإلغاء يكمل.
          if (!(err instanceof NotFoundError)) throw err;
        });
        await repo.addRestocked(orderId, line);
      }
    }
    await repo.setStatus(current.id, next);
    await this.timelineRepo.record(
      orderId,
      { type: "status", from: current.status, to: next, actor, note: options.note ?? options.reason ?? null },
      client
    );
    const order = (await repo.findById(current.id)) as Order;
    await this.events.publish(client, "order.statusChanged", {
      order,
      from: current.status,
      ...(options.reason ? { reason: options.reason } : {}),
    });
    return { order, from: current.status };
  }

  /** المالك أو موظف يغيّر حالة الطلب (PATCH /orders/:id/status). */
  async changeStatus(orderId: string, next: OrderStatus, actor: Actor = SYSTEM_ACTOR, options: { reason?: string; note?: string } = {}): Promise<Order> {
    const { order } = await withTransaction(this.pool, (client) => this.applyStatus(client, orderId, next, actor, options));
    this.events.notify();
    return order;
  }

  /**
   * يسجّل حالة الدفع داخل معاملة قائمة، حسب PAYMENT_TRANSITIONS. نفس الحالة مرة ثانية تُقبل
   * دون تغيير ودون حدث (webhook مكرر). الدفع ("paid") يمسح مهلة الدفع.
   * holdSeconds: مهلة جديدة بالثواني، أو null تمسحها، أو undefined لا تغيّرها.
   */
  async applyPayment(
    client: PoolClient,
    orderId: string,
    status: PaymentStatus,
    reference: string | undefined,
    actor: Actor,
    holdSeconds?: number | null
  ): Promise<Order> {
    const repo = new OrdersRepository(client);
    const current = await repo.findById(orderId, { forUpdate: true });
    if (!current) throw new NotFoundError("Order not found");
    if (current.paymentStatus === status) {
      if (reference && reference !== current.paymentReference) await repo.setPayment(orderId, status, reference);
      return (await repo.findById(orderId)) as Order;
    }
    if (!PAYMENT_TRANSITIONS[current.paymentStatus].includes(status)) {
      throw new ConflictError(
        `Cannot change payment from '${current.paymentStatus}' to '${status}'`,
        { allowed: PAYMENT_TRANSITIONS[current.paymentStatus] },
        ErrorCodes.INVALID_PAYMENT_TRANSITION
      );
    }
    await repo.setPayment(orderId, status, reference, status === "paid" ? null : holdSeconds);
    // دفع وصل بعد إلغاء الطلب (مثلاً بعد انتهاء المهلة): نسجّل الحقيقة (المال وصل)، وننبّه المحل
    // ليسترجعه، بدل رفض الـ webhook فتعيده البوابة بلا نهاية.
    const lateNote = current.status === "cancelled" && status === "paid" ? "Paid after the order was cancelled: refund it" : null;
    if (lateNote) this.logger.warn(lateNote, { orderId });
    await this.timelineRepo.record(orderId, { type: "payment", from: current.paymentStatus, to: status, actor, note: lateNote }, client);
    const order = (await repo.findById(orderId)) as Order;
    await this.events.publish(client, "order.paymentChanged", { order, from: current.paymentStatus });
    return order;
  }

  /**
   * يسجل نتيجة الدفع: يستدعيه المالك (مثلاً "استلمنا النقود" مع الدفع عند الاستلام)،
   * أو مسار webhook تضيفه إضافة بوابة دفع حين تبلغنا البوابة بنجاح الدفع.
   */
  async setPaymentStatus(orderId: string, status: PaymentStatus, reference?: string, actor: Actor = SYSTEM_ACTOR): Promise<Order> {
    const order = await withTransaction(this.pool, (client) => this.applyPayment(client, orderId, status, reference, actor));
    this.events.notify();
    return order;
  }

  /**
   * استرجاع مبلغ (كامل أو جزئي)، مع إعادة كميات للمخزون اختيارياً.
   *
   * على ثلاث مراحل، حتى لا يُسترجع المال مرتين ولا يضيع استرجاع:
   *   أ. معاملة: قفل الطلب، والتحقق (مدفوع؟ المبلغ لا يتجاوز المتبقي؟ الكميات صحيحة؟)، ثم حجز
   *      المبلغ: سطر استرجاع "pending" و refunded_total يزيد. طلب استرجاع ثانٍ متزامن يرى المبلغ
   *      المحجوز فلا يتجاوز الإجمالي.
   *   ب. خارج أي معاملة: بوابة الدفع تسترجع المال (إن كان لها refund). إن رفضت: يُلغى الحجز
   *      ويصل للعميل 502، ولا يتغير شيء آخر.
   *   ج. معاملة: الاسترجاع "succeeded"، وإعادة الكميات للمخزون، وحالة الدفع partially_refunded
   *      أو refunded، وسطر في السجل الزمني، والحدثان order.refunded و order.paymentChanged.
   */
  async refund(orderId: string, input: RefundInput, actor: Actor): Promise<{ order: Order; refund: Refund }> {
    const restock: RestockLine[] = (input.restock ?? []).map((r) => ({
      productId: r.productId,
      variantId: r.variantId ?? null,
      quantity: r.quantity,
    }));

    const { refund: pending, order: before } = await withTransaction(this.pool, async (client) => {
      const repo = new OrdersRepository(client);
      const order = await repo.findById(orderId, { forUpdate: true });
      if (!order) throw new NotFoundError("Order not found");
      if (order.paymentStatus !== "paid" && order.paymentStatus !== "partially_refunded") {
        throw new ConflictError(`Only a paid order can be refunded (payment is '${order.paymentStatus}')`, undefined, ErrorCodes.ORDER_NOT_REFUNDABLE);
      }
      const refundable = order.total - order.refundedTotal;
      if (input.amount > refundable) {
        throw new ConflictError("The refund is larger than the amount left to refund", { refundable }, ErrorCodes.REFUND_EXCEEDS_PAID);
      }
      // الكميات المطلوب إعادتها: كل سطر يجب أن يكون في الطلب، ولا يتجاوز ما لم يُعد بعد.
      const issues: Array<{ field: string; message: string }> = [];
      restock.forEach((line, i) => {
        const item = order.items.find((it) => it.productId === line.productId && it.variantId === line.variantId);
        const requested = restock
          .filter((l) => l.productId === line.productId && l.variantId === line.variantId)
          .reduce((sum, l) => sum + l.quantity, 0);
        if (!item) issues.push({ field: `restock[${i}]`, message: "is not a line of this order" });
        else if (requested > item.quantity - item.restockedQuantity) {
          issues.push({ field: `restock[${i}].quantity`, message: `must be <= ${item.quantity - item.restockedQuantity}` });
        }
      });
      if (issues.length > 0) throw new ValidationError("Validation failed", issues);
      // نحجز الكميات الآن (restocked_quantity)، قبل أن تسترجع البوابة المال: إلغاء أو استرجاع متزامن
      // يرى الحجز فلا يعيد نفس القطع مرتين، ولا يفشل هذا الاسترجاع بعد أن يكون المال قد أُعيد.
      for (const line of [...restock].sort(byStockLockOrder)) await repo.addRestocked(orderId, line);
      const refund = await repo.insertRefund(orderId, input.amount, input.reason ?? null, restock, actor);
      return { refund, order };
    });

    const provider = before.paymentMethod ? this.extensions.paymentProvider(before.paymentMethod) : undefined;
    let reference: string | undefined;
    if (provider?.refund) {
      try {
        reference = (await provider.refund(before, input.amount))?.reference;
      } catch (err) {
        await withTransaction(this.pool, (client) => new OrdersRepository(client).completeRefund(pending.id, { status: "failed" }));
        this.logger.error(`Payment provider '${provider.id}' refused a refund`, {
          orderId,
          message: err instanceof Error ? err.message : String(err),
        });
        throw new BadGatewayError("The payment provider refused the refund", undefined, ErrorCodes.PAYMENT_PROVIDER_ERROR);
      }
    }

    const result = await withTransaction(this.pool, async (client) => {
      const repo = new OrdersRepository(client);
      const current = (await repo.findById(orderId, { forUpdate: true })) as Order;
      const refund = await repo.completeRefund(pending.id, { status: "succeeded", reference });
      const inventory = new InventoryRepository(client);
      // الكميات محجوزة منذ المرحلة أ؛ هنا تعود للمخزون فعلاً.
      for (const line of [...restock].sort(byStockLockOrder)) {
        await inventory.adjustLine(line, line.quantity).catch((err: unknown) => {
          if (!(err instanceof NotFoundError)) throw err;
        });
      }
      const next: PaymentStatus = current.refundedTotal >= current.total ? "refunded" : "partially_refunded";
      await repo.setPayment(orderId, next, undefined);
      await this.timelineRepo.record(
        orderId,
        { type: "refund", from: current.paymentStatus, to: next, actor, note: input.reason ?? `Refunded ${input.amount}` },
        client
      );
      const order = (await repo.findById(orderId)) as Order;
      await this.events.publish(client, "order.refunded", { order, refund });
      await this.events.publish(client, "order.paymentChanged", { order, from: current.paymentStatus });
      return { order, refund };
    });
    this.events.notify();
    return result;
  }

  /**
   * يلغي الطلبات التي انتهت مهلة دفعها ولم تُدفع، ويعيد مخزونها. تشغّله المهمة الدورية
   * orders.releaseExpiredHolds كل دقيقة. كل طلب في معاملته الخاصة، مع إعادة التحقق بعد القفل:
   * إن دُفع الطلب في اللحظة نفسها، لا يُلغى. يرجع عدد الطلبات الملغاة.
   */
  async releaseExpiredHolds(limit = 50): Promise<number> {
    const ids = await new OrdersRepository(this.pool).expiredHolds(limit);
    let released = 0;
    for (const id of ids) {
      try {
        const done = await withTransaction(this.pool, async (client) => {
          const still = await client.query(
            `SELECT 1 FROM orders WHERE id = $1 AND status = 'pending' AND payment_status IN ('unpaid', 'pending', 'failed')
               AND payment_expires_at < now() FOR UPDATE`,
            [id]
          );
          if (still.rows.length === 0) return false;
          await this.applyStatus(client, id, "cancelled", SYSTEM_ACTOR, { reason: "payment_expired" });
          return true;
        });
        if (done) released++;
      } catch (err) {
        this.logger.error("Could not release an expired payment hold", { orderId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (released > 0) this.events.notify();
    return released;
  }

  /** سجل الطلب الزمني. */
  timeline(orderId: string): Promise<OrderEvent[]> {
    return this.timelineRepo.list(orderId);
  }

  /** استرجاعات طلب. */
  refunds(orderId: string): Promise<Refund[]> {
    return new OrdersRepository(this.pool).refunds(orderId);
  }
}

/** رمز الخدمة في الحاوية. تستطيع الإضافات طلبها، مثلاً إضافة دفع إلكتروني تسجل الدفع من webhook. */
export const ORDERS_SERVICE = createToken<OrdersService>("OrdersService");
