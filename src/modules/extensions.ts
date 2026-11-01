import type { Logger } from "../engine/logger";
import type { Order, OrderStatus, PaymentStatus } from "./orders/orders.schema";

/**
 * نقاط التوسع في الإطار (Extension points).
 *
 * الإضافات لا تعدّل كود الإطار. بدلاً من ذلك تسجّل هنا "مزودين" و"مستمعين"، ووحدة الطلبات
 * هي التي تستدعيهم في اللحظة المناسبة:
 *
 *   ShippingProvider : يحسب سعر التوصيل لسلة وعنوان، وقت إتمام الشراء.
 *   PaymentProvider  : يبدأ الدفع مباشرة بعد إنشاء الطلب.
 *   الأحداث          : order.created و order.statusChanged و order.paymentChanged
 *                      (مثلاً إضافة ترسل رسالة للمالك عند كل طلب جديد).
 *
 * لهذا إضافة طريقة دفع أو شحن جديدة لا تحتاج لمس كود الإطار، وهذا مبدأ Open/Closed:
 * الإطار مفتوح للتوسعة، ومغلق أمام التعديل.
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
// لاحظ ما ليس هنا: اسم المشتري وهاتفه وطريقة دفعه. مزود الشحن لا يحتاجها، فلا يستلمها
// (تقليل البيانات، Data minimization). كان يستلمها سابقاً: الخطأ رقم 4 في جدول 6.5.

/** طريقة شحن، مثل "توصيل للمنزل" أو "استلام من المحل". */
export interface ShippingProvider {
  /** معرّف فريد يرسله الموقع عند الشراء، مثل "city-rate" أو "pickup". */
  id: string;
  /** الاسم الذي يظهر للمشتري. */
  name: string;
  /**
   * المدن التي تصلها هذه الطريقة. إن وُجدت، يعرضها الموقع قائمة منسدلة، ويشترط إتمام
   * الشراء اختيار واحدة منها (انظر cityRateShipping).
   */
  cities?: string[];
  /**
   * سعر الشحن بأصغر وحدة للعملة. يعمل داخل معاملة إتمام الشراء، لذلك يجب أن يكون سريعاً:
   * أي بطء فيه يُبقي أقفال القاعدة مفتوحة.
   */
  quote(input: ShippingQuoteInput): number | Promise<number>;
}

/** نتيجة بدء الدفع. */
export interface PaymentResult {
  /** حالة الدفع بعد البدء: pending أو paid أو failed (ليس unpaid ولا refunded). */
  status: Exclude<PaymentStatus, "unpaid" | "refunded">;
  /** تعليمات تظهر للمشتري، مثل "ادفع للمندوب نقداً". */
  instructions?: string;
  /** لبوابات الدفع التي تنقل المشتري إلى صفحة دفع خارجية. */
  redirectUrl?: string;
  /** رقم العملية في بوابة الدفع. */
  reference?: string;
}

/** طريقة دفع، مثل "الدفع عند الاستلام". */
export interface PaymentProvider {
  id: string;
  name: string;
  /**
   * تُستدعى بعد حفظ الطلب نهائياً (بعد COMMIT). فشلها لا يلغي الطلب أبداً، بل يُحفظ الطلب
   * بحالة دفع "failed". ولا نحجز أقفال القاعدة أثناء انتظار جهة خارجية.
   */
  initiate(order: Order): PaymentResult | Promise<PaymentResult>;
}

/** الأحداث الثلاثة، وما يستلمه المستمع مع كل حدث. */
export interface CommerceEvents {
  /** طلب جديد أُنشئ. */
  "order.created": { order: Order };
  /** حالة الطلب تغيرت، و from هي الحالة السابقة. */
  "order.statusChanged": { order: Order; from: OrderStatus };
  /** حالة الدفع تغيرت، و from هي الحالة السابقة. */
  "order.paymentChanged": { order: Order; from: PaymentStatus };
}

/** المستمع: دالة تستلم بيانات الحدث. نوع البيانات يتبع اسم الحدث تلقائياً. */
type Listener<E extends keyof CommerceEvents> = (payload: CommerceEvents[E]) => void | Promise<void>;

/**
 * سجل الإضافات: يحفظ طرق الشحن، وطرق الدفع، ومستمعي الأحداث.
 * يُنشأ مرة واحدة في createCommerceApp، ويصل للجميع عبر ModuleContext.extensions.
 */
export class ExtensionRegistry {
  private readonly shipping = new Map<string, ShippingProvider>();
  private readonly payment = new Map<string, PaymentProvider>();
  private readonly listeners = new Map<keyof CommerceEvents, Array<Listener<keyof CommerceEvents>>>();

  constructor(private readonly logger: Logger) {}

  /**
   * يضيف طريقة شحن. معرّف مكرر يوقف الإقلاع فوراً بخطأ واضح: إضافتان بنفس id
   * خطأ إعداد يجب أن يُكتشف عند التشغيل، لا عند أول عملية شراء.
   */
  addShippingProvider(provider: ShippingProvider): void {
    if (this.shipping.has(provider.id)) throw new Error(`Shipping provider '${provider.id}' is already registered`);
    this.shipping.set(provider.id, provider);
  }

  /** يضيف طريقة دفع. نفس قاعدة المعرّف المكرر. */
  addPaymentProvider(provider: PaymentProvider): void {
    if (this.payment.has(provider.id)) throw new Error(`Payment provider '${provider.id}' is already registered`);
    this.payment.set(provider.id, provider);
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

  /**
   * يسجل مستمعاً لحدث. مثال من إضافة:
   *   extensions.on("order.created", ({ order }) => logger.info(`طلب جديد ${order.id}`));
   */
  on<E extends keyof CommerceEvents>(event: E, listener: Listener<E>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener<keyof CommerceEvents>);
    this.listeners.set(event, list);
  }

  /**
   * يطلق الحدث: يشغّل كل مستمعيه بالترتيب. المستمع الذي يفشل يُسجَّل خطؤه ويُتجاوز.
   * السبب: إضافة إشعارات معطوبة يجب ألا تحوّل طلباً ناجحاً إلى خطأ أمام المشتري.
   */
  async emit<E extends keyof CommerceEvents>(event: E, payload: CommerceEvents[E]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        await listener(payload);
      } catch (err) {
        this.logger.error(`Listener for '${event}' failed`, { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
