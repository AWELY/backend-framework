import type { Pool, QueryResultRow } from "pg";
import type { AppRequest } from "../../engine/http/request";
import type { AccessControl } from "../../engine/access-control";
import type { Logger } from "../../engine/logger";
import { ConflictError, NotFoundError, ValidationError } from "../../engine/errors";
import { withTransaction } from "../../db/transaction";
import { translateDbError } from "../../db/errors";
import type { Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import { InventoryRepository } from "../inventory/inventory.repository";
import { assertCartAccess, assertCartOpen } from "../cart/cart.access";
import type { CartHeader } from "../cart/cart.schema";
import type { ExtensionRegistry, PaymentProvider, PaymentResult, ShippingProvider } from "../extensions";
import { OrdersRepository } from "./orders.repository";
import {
  STATUS_TRANSITIONS,
  type CheckoutInput,
  type QuoteInput,
  type Order,
  type OrderItem,
  type OrderStatus,
  type PaymentStatus,
} from "./orders.schema";

/** سطر سلة مع بيانات منتجه الحالية، كما يُقرأ عند إتمام الشراء. */
interface LineRow {
  product_id: string;
  quantity: number;
  name: string;
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

/** نتيجة إتمام الشراء: الطلب، وما قالته إضافة الدفع. */
export interface CheckoutResult {
  order: Order;
  /** ما ردت به إضافة الدفع (تعليمات أو رابط تحويل)، أو null إن لم يكن للمتجر إضافة دفع. */
  payment: PaymentResult | null;
}

/** تسعير السلة قبل الشراء: مجموع المنتجات، وطريقة الشحن وسعرها، والإجمالي. */
export interface Quote {
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  total: number;
}

/**
 * خدمة الطلبات: العمليات التي تتكون من عدة خطوات، وكل عملية في معاملة واحدة
 * (إما أن تحدث كل الخطوات، وإما لا شيء).
 *
 * لماذا "خدمة" (Service) منفصلة عن المستودع؟ المستودع يقرأ ويكتب جدولاً واحداً فقط.
 * أما إتمام الشراء فينسّق بين عدة أشياء: السلة، والمخزون، والطلبات، وإضافات الشحن والدفع،
 * والأحداث. هذا "منطق العمل" (Business logic)، ومكانه الخدمة.
 *
 * ثلاث قواعد للتوقيت:
 *   1. الشحن يُسعَّر داخل معاملة الشراء، لأن السعر جزء من الطلب نفسه.
 *   2. الدفع يبدأ فقط بعد COMMIT: بوابة دفع بطيئة أو معطوبة يجب ألا تُبقي أقفال القاعدة
 *      مفتوحة، ولا أن تلغي طلباً صحيحاً.
 *   3. الأحداث تُطلق بعد COMMIT أيضاً، فلا يرى أي مستمع طلباً أُلغي بعد ذلك بـ ROLLBACK.
 */
export class OrdersService {
  constructor(
    private readonly pool: Pool,
    private readonly accessControl: AccessControl,
    private readonly extensions: ExtensionRegistry,
    private readonly logger: Logger
  ) {}

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

  /**
   * يسأل إضافة الشحن عن السعر. بلا إضافة شحن يكون السعر 0.
   * نتأكد من رد الإضافة: يجب أن يكون رقماً صحيحاً غير سالب. إضافة ترد بقيمة خاطئة خطأ
   * برمجي فيها، فنرمي Error عادياً (500)، وتُلغى المعاملة كاملة.
   */
  private async shippingCost(
    provider: ShippingProvider | null,
    lines: LineRow[],
    destination: { shippingAddress: string; shippingCity?: string }
  ): Promise<number> {
    if (!provider) return 0;
    const items = lines.map((l) => ({ productId: l.product_id, quantity: l.quantity, unitPrice: l.price }));
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    // نمرر فقط ما يحتاجه التسعير، لا اسم المشتري ولا هاتفه ولا طريقة دفعه (تقليل البيانات).
    const cost = await provider.quote({
      items,
      subtotal,
      shippingAddress: destination.shippingAddress,
      shippingCity: destination.shippingCity,
    });
    if (!Number.isInteger(cost) || cost < 0) {
      throw new Error(`Shipping provider '${provider.id}' returned an invalid cost: ${cost}`);
    }
    return cost;
  }

  /** سطور السلة مع الاسم والسعر الحاليين لكل منتج، وهل هو نشط، بترتيب الإضافة. */
  private loadLines(db: Queryable, cartId: string) {
    return query<LineRow>(
      db,
      `SELECT ci.product_id, ci.quantity, p.name, p.price, p.is_active
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [cartId]
    );
  }

  /**
   * يسعّر السلة مع طريقة شحن قبل الشراء، دون أي أثر جانبي: لا يغيّر مخزوناً، ولا ينشئ طلباً.
   * يستخدمه الموقع ليعرض الإجمالي عند اختيار المدينة أو طريقة الشحن (POST /checkout/quote).
   * المنتجات غير النشطة لا تُحسب.
   */
  async quote(req: AppRequest, input: QuoteInput): Promise<Quote> {
    const header = await query<{ id: string; customer_id: string | null; status: CartHeader["status"] }>(
      this.pool,
      "SELECT id, customer_id, status FROM carts WHERE id = $1",
      [input.cartId]
    );
    const row = header.rows[0];
    // نفس قاعدة الوصول للسلة: من لا يملكها يحصل على 404.
    const cart = assertCartAccess(req, row ? { id: row.id, customerId: row.customer_id, status: row.status } : null, this.accessControl);
    const lines = (await this.loadLines(this.pool, cart.id)).rows.filter((l) => l.is_active);
    const provider = this.resolveShipping(input.shippingMethod);
    const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
    const shippingCost = await this.shippingCost(provider, lines, input);
    return { subtotal, shippingMethod: provider?.id ?? null, shippingCost, total: subtotal + shippingCost };
  }

  /**
   * إتمام الشراء: تحويل السلة إلى طلب. أهم عملية في الإطار.
   *
   * داخل معاملة واحدة:
   *   1. قفل صف السلة (SELECT ... FOR UPDATE): لو ضغط المشتري "تأكيد الطلب" مرتين بسرعة،
   *      تنتظر المعاملة الثانية حتى تنتهي الأولى، ثم تجد السلة "checked_out" فتحصل على 409.
   *   2. التحقق: يحق لك هذه السلة؟ ما زالت مفتوحة؟ ليست فارغة؟ كل منتجاتها ما زالت نشطة؟
   *   3. إنقاص المخزون لكل سطر بتحديث ذري (InventoryRepository.adjust). إن نقص سطر واحد،
   *      تُلغى المعاملة كاملة (ROLLBACK)، فلا يُباع شيء أبداً، ولا يبقى مخزون ناقص بلا طلب.
   *   4. إنشاء الطلب مع نسخ اسم كل منتج وسعره إلى order_items (صورة ثابتة وقت الشراء).
   *   5. حساب سعر الشحن من الإضافة.
   *   6. تعليم السلة "checked_out".
   * بعد COMMIT:
   *   7. بدء الدفع عبر إضافة الدفع. فشلها يُسجَّل، ويُحفظ الطلب بحالة دفع "failed"، ولا يُلغى.
   *   8. إطلاق الحدث order.created.
   */
  async checkout(req: AppRequest, input: CheckoutInput): Promise<CheckoutResult> {
    // قبل فتح المعاملة: نتأكد أن طريقتي الشحن والدفع صحيحتان. خطأ هنا لا يكلف القاعدة شيئاً.
    const shipping = this.resolveShipping(input.shippingMethod);
    const paymentProvider = this.resolvePayment(input.paymentMethod);

    const orderId = await withTransaction(this.pool, async (client) => {
      // الخطوة 1: قفل السلة. كل الاستعلامات التالية تمر عبر client، فتكون جزءاً من المعاملة.
      const locked = await query<{ id: string; customer_id: string | null; status: CartHeader["status"] }>(
        client,
        "SELECT id, customer_id, status FROM carts WHERE id = $1 FOR UPDATE",
        [input.cartId]
      );
      const row = locked.rows[0];
      // الخطوة 2: الصلاحية والحالة.
      const cart = assertCartAccess(
        req,
        row ? { id: row.id, customerId: row.customer_id, status: row.status } : null,
        this.accessControl
      );
      assertCartOpen(cart);

      const lines = (await this.loadLines(client, cart.id)).rows;
      if (lines.length === 0) throw new ValidationError("The cart is empty");
      // منتج أُخفي بعد إضافته إلى السلة: نرفض الشراء ونذكر المنتجات، ليحذفها المشتري.
      const unavailable = lines.filter((l) => !l.is_active).map((l) => l.product_id);
      if (unavailable.length > 0) {
        throw new ConflictError("Some products in the cart are no longer available", { productIds: unavailable });
      }

      // الخطوة 3: إنقاص المخزون. نسخة من المستودع باتصال المعاملة، لا من الحاوية.
      // مخزون غير كافٍ لأي سطر يرمي 409، و withTransaction يلغي كل ما سبق.
      const inventory = new InventoryRepository(client);
      for (const line of lines) {
        await inventory.adjust(line.product_id, -line.quantity);
      }

      // الخطوة 4: سطور الطلب بنسخة ثابتة من الاسم والسعر الحاليين.
      const items: OrderItem[] = lines.map((l) => ({
        productId: l.product_id,
        productName: l.name,
        unitPrice: l.price,
        quantity: l.quantity,
        lineTotal: l.price * l.quantity,
      }));
      // صاحب الطلب: زبون السلة إن كانت مربوطة بزبون، وإلا الزبون المسجل دخوله الآن،
      // وإلا null (طلب ضيف).
      const customerId = cart.customerId ?? (req.auth?.role === "customer" ? (req.auth.userId ?? null) : null);

      const id = await new OrdersRepository(client).insert({
        customerId,
        cartId: cart.id,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        shippingAddress: input.shippingAddress,
        shippingCity: input.shippingCity ?? null,
        subtotal: items.reduce((sum, i) => sum + i.lineTotal, 0),
        shippingMethod: shipping?.id ?? null,
        // الخطوة 5: سعر الشحن، داخل المعاملة.
        shippingCost: await this.shippingCost(shipping, lines, input),
        paymentMethod: paymentProvider?.id ?? null,
        items,
      });
      // الخطوة 6: السلة لم تعد قابلة للتعديل ولا للشراء مرة أخرى.
      await query(client, "UPDATE carts SET status = 'checked_out', updated_at = now() WHERE id = $1", [cart.id]);
      return id;
    });
    // هنا حدث COMMIT: الطلب محفوظ نهائياً.

    // الخطوة 7: الدفع، خارج المعاملة.
    const orders = new OrdersRepository(this.pool);
    let payment: PaymentResult | null = null;
    if (paymentProvider) {
      try {
        payment = await paymentProvider.initiate((await orders.findById(orderId)) as Order);
      } catch (err) {
        // بوابة الدفع فشلت: نسجل الخطأ، والطلب يبقى، بحالة دفع "failed" يتابعها المالك.
        this.logger.error(`Payment provider '${paymentProvider.id}' failed to start payment`, {
          orderId,
          message: err instanceof Error ? err.message : String(err),
        });
        payment = { status: "failed" };
      }
      await orders.setPayment(orderId, payment.status, payment.reference);
    }

    // الخطوة 8: الحدث، بعد أن أصبح كل شيء نهائياً.
    const order = (await orders.findById(orderId)) as Order;
    await this.extensions.emit("order.created", { order });
    return { order, payment };
  }

  /**
   * المالك يغيّر حالة الطلب، حسب الانتقالات المسموحة في STATUS_TRANSITIONS.
   * الإلغاء (cancelled) يعيد كميات الطلب إلى المخزون، في نفس المعاملة التي تغيّر الحالة.
   */
  async changeStatus(orderId: string, next: OrderStatus): Promise<Order> {
    const { order, from } = await withTransaction(this.pool, async (client) => {
      const orders = new OrdersRepository(client);
      // forUpdate: نقفل صف الطلب، فلا يغيّر طلبان متزامنان حالته في نفس اللحظة.
      const current = await orders.findById(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Order not found");
      // انتقال غير مسموح، مثل delivered إلى pending: 409، مع قائمة الانتقالات المسموحة.
      if (!STATUS_TRANSITIONS[current.status].includes(next)) {
        throw new ConflictError(`Cannot change an order from '${current.status}' to '${next}'`, {
          allowed: STATUS_TRANSITIONS[current.status],
        });
      }
      if (next === "cancelled") {
        const inventory = new InventoryRepository(client);
        for (const item of current.items) {
          // منتج حُذف بعد الطلب يصبح product_id فيه NULL، فلا شيء نعيده إلى المخزون.
          if (item.productId) await inventory.adjust(item.productId, item.quantity);
        }
      }
      await orders.setStatus(current.id, next);
      return { order: (await orders.findById(current.id)) as Order, from: current.status };
    });
    // الحدث بعد COMMIT، ومعه الحالة السابقة.
    await this.extensions.emit("order.statusChanged", { order, from });
    return order;
  }

  /**
   * يسجل نتيجة الدفع: يستدعيه المالك (مثلاً "استلمنا النقود" مع الدفع عند الاستلام)،
   * أو مسار webhook تضيفه إضافة بوابة دفع حين تبلغنا البوابة بنجاح الدفع.
   */
  async setPaymentStatus(orderId: string, status: PaymentStatus, reference?: string): Promise<Order> {
    const { order, from } = await withTransaction(this.pool, async (client) => {
      const orders = new OrdersRepository(client);
      const current = await orders.findById(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Order not found");
      await orders.setPayment(current.id, status, reference);
      return { order: (await orders.findById(current.id)) as Order, from: current.paymentStatus };
    });
    await this.extensions.emit("order.paymentChanged", { order, from });
    return order;
  }
}

/** رمز الخدمة في الحاوية. تستطيع الإضافات طلبها، مثلاً إضافة دفع إلكتروني تسجل الدفع من webhook. */
export const ORDERS_SERVICE = createToken<OrdersService>("OrdersService");
