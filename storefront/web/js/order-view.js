import { esc, money, formatDate, ORDER_STATUS, PAYMENT_STATUS } from "./ui.js";

// مراحل الطلب بالترتيب، لشريط التقدم. الإلغاء ليس مرحلة، بل يُعرض كرسالة.
const STEPS = ["pending", "confirmed", "shipped", "delivered"];

/**
 * اسم الحالة كما يفهمه المشتري. طلب "الاستلام من المحل" لا يخرج مع مندوب، فحالة shipped
 * تعني له "جاهز للاستلام" لا "في الطريق إليك"، و delivered تعني "تم الاستلام" لا "تم التوصيل".
 */
export function statusLabel(order, status = order.status) {
  if (order.shippingMethod === "pickup") {
    if (status === "shipped") return "جاهز للاستلام من المحل";
    if (status === "delivered") return "تم الاستلام";
  }
  return ORDER_STATUS[status] ?? status;
}

/** حالة الدفع بجملة للمشتري: "pending" في هذا المتجر تعني أنه يدفع نقداً عند الاستلام. */
const paymentText = (order) => (order.paymentStatus === "pending" ? "نقداً عند الاستلام" : PAYMENT_STATUS[order.paymentStatus] ?? order.paymentStatus);

/**
 * سطر واحد من سجل الطلب (من GET /orders/:id/history في إضافة customer-orders) كنص للمشتري.
 * يرجع [النص، نوع النقطة]: good للنجاح، و bad للإلغاء والفشل، و "" للعادي.
 */
function eventText(order, e) {
  if (e.kind === "created") return ["تم استلام طلبك", ""];
  if (e.kind === "payment") {
    if (e.to === "paid") return ["تم الدفع", "good"];
    if (e.to === "refunded") return ["أُعيد المبلغ", ""];
    if (e.to === "failed") return ["فشل الدفع", "bad"];
    return [`الدفع: ${PAYMENT_STATUS[e.to] ?? e.to}`, ""];
  }
  if (e.to === "confirmed") return ["أكّد المتجر الطلب", ""];
  if (e.to === "shipped") return [order.shippingMethod === "pickup" ? "الطلب جاهز للاستلام من المحل" : "خرج الطلب مع المندوب", ""];
  if (e.to === "delivered") return [order.shippingMethod === "pickup" ? "استلمت الطلب من المحل" : "تم التسليم", "good"];
  if (e.to === "cancelled") return ["أُلغي الطلب", "bad"];
  return [statusLabel(order, e.to), ""];
}

/**
 * طلب واحد كبطاقة: شريط التقدم (مع وقت كل مرحلة إن وُجد السجل)، والمنتجات والمجموع،
 * وسجل الطلب الكامل داخل <details> (يُفتح بالضغط، بلا JavaScript).
 * تستخدمها صفحتا "طلباتي" و"تتبع طلبك".
 *
 *   history : سجل الطلب من الـ API، أو null إن تعذر جلبه (البطاقة تعمل بدونه).
 *   actions : HTML لأزرار تحت البطاقة (مثل "إلغاء الطلب")، تبنيه الصفحة نفسها.
 *
 * كل قيمة جاءت من الـ API وفيها نص (الرقم، والاسم، والعنوان...) تمر عبر esc قبل وضعها في
 * HTML. لو دسّ أحد <script> في عنوانه، يظهر نصاً عادياً ولا يعمل (حماية من XSS).
 * الأرقام (الكمية) و money(...) لا تحتاج esc، لأنها لا تحتوي رموز HTML.
 */
export function orderCard(order, { history = null, actions = "" } = {}) {
  // رقم المرحلة الحالية: كل مرحلة رقمها أقل منه أو يساويه تُعلَّم "done".
  const reached = STEPS.indexOf(order.status);
  // متى وصل الطلب إلى كل مرحلة: من السجل، و"قيد المراجعة" منذ إنشاء الطلب.
  const reachedAt = { pending: order.createdAt };
  for (const e of history ?? []) if (e.kind === "status" && !reachedAt[e.to]) reachedAt[e.to] = e.at;

  const progress =
    order.status === "cancelled"
      ? `<div class="alert error">تم إلغاء هذا الطلب${reachedAt.cancelled ? ` في ${esc(formatDate(reachedAt.cancelled))}` : ""}.</div>`
      : `<div class="steps">${STEPS.map((s, i) => `
          <div class="step ${i <= reached ? "done" : ""}">${esc(statusLabel(order, s))}
            ${i <= reached && reachedAt[s] ? `<time datetime="${esc(reachedAt[s])}">${esc(formatDate(reachedAt[s]))}</time>` : ""}
          </div>`).join("")}</div>`;

  const log = history?.length
    ? `<details class="order-log"><summary>سجل الطلب (${history.length})</summary>
        <ol class="timeline">${history.map((e) => {
          const [text, kind] = eventText(order, e);
          return `<li class="${kind}"><b>${esc(text)}</b><time datetime="${esc(e.at)}">${esc(formatDate(e.at))}</time></li>`;
        }).join("")}</ol></details>`
    : "";

  return `
    <article class="order-card" data-order="${esc(order.id)}">
      <div class="head">
        <span>طلب <span class="order-id">${esc(order.id.slice(0, 8))}</span> <span class="when">${esc(formatDate(order.createdAt))}</span></span>
        <span class="status ${esc(order.status)}">${esc(statusLabel(order))}</span>
      </div>
      ${progress}
      <table class="items-table">
        ${order.items.map((i) => `<tr><td>${esc(i.productName)} × ${i.quantity}</td><td>${money(i.lineTotal)}</td></tr>`).join("")}
        <tr><td>${order.shippingMethod === "pickup" ? "الاستلام من المحل" : `التوصيل${order.shippingCity ? ` إلى ${esc(order.shippingCity)}` : ""}`}</td><td>${order.shippingCost === 0 ? "مجاناً" : money(order.shippingCost)}</td></tr>
        <tr><td>الإجمالي</td><td>${money(order.total)}</td></tr>
      </table>
      <div class="order-meta">
        <span>الدفع: <b>${esc(paymentText(order))}</b></span>
        ${order.shippingMethod === "pickup" ? "" : `<span>العنوان: <b>${esc(order.shippingAddress)}</b></span>`}
        <span>رقم الطلب الكامل: <span class="order-id">${esc(order.id)}</span></span>
      </div>
      ${log}
      ${actions ? `<div class="order-actions">${actions}</div>` : ""}
    </article>`;
}
