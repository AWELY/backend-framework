import type { Logger } from "../engine/logger";
import type { EventMeta, EventListener } from "../runtime/outbox";
import type { Order, OrderStatus, PaymentStatus, Refund } from "./orders/orders.schema";
import type { Product } from "./products/products.schema";
import type { Customer } from "./customers/customers.schema";
import type { Delivery } from "./delivery/delivery.schema";

/**
 * نقاط التوسعة (Extension points): الأماكن التي تستطيع الإضافات (Plugins) أن تضيف فيها سلوكاً
 * دون أن تلمس كود الوحدات. أربعة أنواع:
 *
 *   1. طرق الشحن (ShippingProvider): كيف يُحسب سعر التوصيل.
 *   2. طرق الدفع (PaymentProvider): كيف يبدأ الدفع، وكيف يُسترجع المال، وكم تُحجز البضاعة بانتظاره.
 *   3. معدّلات السعر (PriceAdjuster): خصومات وكوبونات وضرائب ورسوم تُضاف إلى الطلب.
 *   4. الأحداث (CommerceEvents): "حدث شيء"، والإضافة تستمع وتتصرف (بريد، رسالة، إحصاءات).
 *
 * الشرح الكامل مع أمثلة في docs/EXTENDING.md.
 */

/** ما يستلمه مزود الشحن لحساب السعر. */
export interface ShippingQuoteInput {
  /** المنتجات وكمياتها وأسعارها. */
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  /** مجموع المنتجات، بأصغر وحدة للعملة (الدرهم: 1 دينار = 1000 درهم). */
  subtotal: number;
  shippingAddress: string;
  /** المدينة التي اختارها المشتري (من قائمة cities للمزود، إن كانت له قائمة). */
  shippingCity?: string;
}

/** طريقة شحن، مثل "توصيل للمنزل" أو "استلام من المحل". */
export interface ShippingProvider {
  /** معرّف فريد يرسله الموقع عند الشراء، مثل "city-rate" أو "pickup". */
  id: string;
  /** الاسم الذي يظهر للمشتري. */
  name: string;
  /**
   * المدن التي يخدمها المزود، إن كان السعر يعتمد على المدينة. يعرضها GET /checkout/options
   * ليبني الموقع منها قائمة اختيار.
   */
  cities?: string[];
  /**
   * يحسب سعر الشحن بأصغر وحدة للعملة (رقم صحيح غير سالب). قد يرمي ValidationError
   * (مثلاً مدينة لا يخدمها)، فيصل للعميل 400.
   */
  quote(input: ShippingQuoteInput): number | Promise<number>;
}

/** نتيجة بدء الدفع. */
export interface PaymentResult {
  /** حالة الدفع بعد البدء: pending أو paid أو failed. */
  status: "pending" | "paid" | "failed";
  /** تعليمات تظهر للمشتري، مثل "ادفع للمندوب نقداً". */
  instructions?: string;
  /** لبوابات الدفع التي تنقل المشتري إلى صفحة دفع خارجية. */
  redirectUrl?: string;
  /** رقم العملية في بوابة الدفع. */
  reference?: string;
}

/** طريقة دفع، مثل "الدفع عند الاستلام" أو بوابة دفع إلكتروني. */
export interface PaymentProvider {
  id: string;
  name: string;
  /**
   * يبدأ الدفع لطلب أُنشئ للتو. يُستدعى بعد COMMIT، فبوابة بطيئة لا تُبقي أقفال القاعدة مفتوحة،
   * وبوابة معطوبة لا تلغي الطلب (يُحفظ بحالة دفع failed).
   */
  initiate(order: Order): PaymentResult | Promise<PaymentResult>;
  /**
   * كم ثانية تبقى البضاعة محجوزة بانتظار الدفع الإلكتروني. بعدها يُلغى الطلب غير المدفوع ويعود
   * مخزونه تلقائياً (المهمة orders.releaseExpiredHolds). بدونها لا مهلة (مثل الدفع عند الاستلام).
   */
  holdSeconds?: number;
  /**
   * يسترجع مبلغاً عبر البوابة (POST /orders/:id/refunds). يرمي إن رفضت البوابة، فيُلغى الاسترجاع
   * ويصل للعميل 502. بدونها يُسجَّل الاسترجاع يدوياً (المحل أعاد النقود بنفسه).
   */
  refund?(order: Order, amount: number): { reference?: string } | Promise<{ reference?: string }>;
}

/** بند تعديل على السعر: خصم يُطرح، أو ضريبة أو رسوم تُضاف. */
export interface PriceAdjustment {
  /** رمز ثابت تقرؤه البرامج، مثل "COUPON:SUMMER10" أو "VAT". */
  code: string;
  /** النص الذي يظهر للمشتري، مثل "خصم الصيف 10%". */
  label: string;
  type: "discount" | "tax" | "fee";
  /** المبلغ بأصغر وحدة للعملة، رقم صحيح موجب دائماً. النوع يحدد هل يُطرح أو يُضاف. */
  amount: number;
  /** معرّف المعدّل الذي أضاف البند (يملؤه الإطار). */
  source?: string;
}

/** ما يستلمه معدّل السعر. */
export interface PricingContext {
  items: ReadonlyArray<{ productId: string; variantId: string | null; quantity: number; unitPrice: number }>;
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  shippingCity?: string;
  /** الكوبون الذي أدخله المشتري، إن وُجد. */
  couponCode?: string;
  customerId: string | null;
  currency: string;
  /** ما أضافته المعدّلات السابقة (الضريبة تُحسب عادة بعد الخصم). */
  adjustments: readonly PriceAdjustment[];
}

/**
 * معدّل سعر: يُستدعى عند التسعير (POST /checkout/quote) وعند الشراء، بترتيب تثبيت الإضافات.
 * يرجع بنوداً (قد تكون قائمة فارغة). يرمي ValidationError لكوبون غير صالح، فيصل للعميل 400.
 * يُستدعى داخل معاملة الشراء، فيجب أن يكون سريعاً ولا يكتب شيئاً خارج القاعدة.
 */
export interface PriceAdjuster {
  id: string;
  adjust(context: PricingContext): PriceAdjustment[] | Promise<PriceAdjustment[]>;
}

/**
 * كل الأحداث، وما يستلمه المستمع مع كل حدث. تُكتب في صندوق الصادر في نفس معاملة التغيير،
 * وتصل للمستمعين بعد لحظات من العامل في الخلفية (src/runtime/outbox.ts).
 */
export interface CommerceEvents {
  /** طلب جديد أُنشئ (حالة الدفع فيه قبل بدء الدفع؛ نتيجة الدفع تصل في order.paymentChanged). */
  "order.created": { order: Order };
  /** حالة الطلب تغيرت، و from هي الحالة السابقة. reason مثل "payment_expired" للإلغاء التلقائي. */
  "order.statusChanged": { order: Order; from: OrderStatus; reason?: string };
  /** حالة الدفع تغيرت، و from هي الحالة السابقة. */
  "order.paymentChanged": { order: Order; from: PaymentStatus };
  /** استرجاع مبلغ نجح. */
  "order.refunded": { order: Order; refund: Refund };
  /** التوصيل تغيّر: إسناد لمندوب، أو استلام، أو تسليم، أو محاولة فاشلة. */
  "order.deliveryChanged": { order: Order; delivery: Delivery };
  "product.created": { product: Product };
  "product.updated": { product: Product };
  "product.deleted": { productId: string };
  /** مخزون تغيّر بيد المالك أو بإرجاع (لا يُطلق لكل عملية شراء: order.created يكفي لها). */
  "inventory.changed": { productId: string; variantId: string | null; quantity: number; reason: string };
  "customer.registered": { customer: Customer };
  /**
   * زبون طلب استعادة كلمة المرور. الإضافة ترسل الرمز إليه (بريد أو رسالة). البيانات حساسة:
   * تُمسح من القاعدة بعد التسليم.
   */
  "customer.passwordResetRequested": { customer: Customer; token: string; expiresAt: Date };
}

/** المستمع: دالة تستلم بيانات الحدث ومعلوماته. نوع البيانات يتبع اسم الحدث تلقائياً. */
export type Listener<E extends keyof CommerceEvents> = (
  payload: CommerceEvents[E],
  meta: EventMeta
) => void | Promise<void>;

/**
 * سجل نقاط التوسعة: تملؤه الإضافات في setup، وتقرؤه الوحدات (الطلبات، والتسعير) والعامل في الخلفية.
 */
export class ExtensionRegistry {
  private readonly shipping = new Map<string, ShippingProvider>();
  private readonly payment = new Map<string, PaymentProvider>();
  private readonly adjusters: PriceAdjuster[] = [];
  private readonly listenerMap = new Map<string, EventListener[]>();

  constructor(private readonly logger: Logger) {}

  /**
   * يضيف طريقة شحن. المعرّف المكرر يُرفض عند الإقلاع (خطأ في إعداد الإضافات)، بدل أن تحل
   * طريقة محل أخرى بصمت.
   */
  addShippingProvider(provider: ShippingProvider): void {
    if (this.shipping.has(provider.id)) throw new Error(`Shipping provider '${provider.id}' is already registered`);
    this.shipping.set(provider.id, provider);
  }

  /** يضيف طريقة دفع. نفس قاعدة المعرّف المكرر. */
  addPaymentProvider(provider: PaymentProvider): void {
    if (this.payment.has(provider.id)) throw new Error(`Payment provider '${provider.id}' is already registered`);
    if (provider.holdSeconds !== undefined && (!Number.isInteger(provider.holdSeconds) || provider.holdSeconds < 60)) {
      throw new Error(`Payment provider '${provider.id}': holdSeconds must be an integer of at least 60`);
    }
    this.payment.set(provider.id, provider);
  }

  /** يضيف معدّل سعر. تُستدعى المعدّلات بترتيب إضافتها. */
  addPriceAdjuster(adjuster: PriceAdjuster): void {
    if (this.adjusters.some((a) => a.id === adjuster.id)) throw new Error(`Price adjuster '${adjuster.id}' is already registered`);
    this.adjusters.push(adjuster);
  }

  /** طريقة الشحن بهذا المعرّف، أو undefined. */
  shippingProvider(id: string): ShippingProvider | undefined {
    return this.shipping.get(id);
  }

  /** طريقة الدفع بهذا المعرّف، أو undefined. */
  paymentProvider(id: string): PaymentProvider | undefined {
    return this.payment.get(id);
  }

  /** كل طرق الشحن، يعرضها المسار GET /checkout/options لصفحة إتمام الشراء. */
  shippingProviders(): ShippingProvider[] {
    return [...this.shipping.values()];
  }

  /** كل طرق الدفع. */
  paymentProviders(): PaymentProvider[] {
    return [...this.payment.values()];
  }

  /** كل معدّلات السعر بترتيبها. */
  priceAdjusters(): readonly PriceAdjuster[] {
    return this.adjusters;
  }

  /**
   * يسجّل مستمعاً لحدث. نوع payload يتبع اسم الحدث تلقائياً، مثل { order } مع "order.created".
   * التسليم "مرة واحدة على الأقل": المستمع قد يُستدعى مرتين لنفس الحدث في حالات نادرة،
   * فليستخدم meta.id ليتجاهل ما عالجه من قبل.
   * الترتيب مهم: رقم المستمع (ترتيب تسجيله) هو ما يحفظه صندوق الصادر ليعرف من نجح معه.
   */
  on<E extends keyof CommerceEvents>(event: E, listener: Listener<E>): void {
    const list = this.listenerMap.get(event) ?? [];
    list.push(listener as unknown as EventListener);
    this.listenerMap.set(event, list);
  }

  /** مستمعو حدث بترتيب تسجيلهم (يقرؤها صندوق الصادر). */
  listeners(event: string): readonly EventListener[] {
    return this.listenerMap.get(event) ?? [];
  }

  /**
   * يشغّل المستمعين فوراً وبالترتيب، دون صندوق الصادر. باقٍ للتوافق مع الإضافات القديمة التي
   * تطلق أحداثها بنفسها. الإطار نفسه لا يستخدمه: أحداثه تمر بصندوق الصادر لتكون موثوقة.
   * مستمع يرمي خطأ يُسجَّل في السجل، ولا يمنع البقية.
   */
  async emit<E extends keyof CommerceEvents>(event: E, payload: CommerceEvents[E]): Promise<void> {
    const meta: EventMeta = { id: `inline-${Date.now()}`, event, version: 1, occurredAt: new Date(), attempt: 1 };
    for (const listener of this.listeners(event)) {
      try {
        await (listener as unknown as Listener<E>)(payload, meta);
      } catch (err) {
        this.logger.error(`Listener for '${event}' failed`, { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
