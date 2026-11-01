import { api } from "./api.js";
import { esc, money, formatDate, timelineText, ORDER_STATUS, PAYMENT_STATUS, DELIVERY_STATUS, icon } from "./ui.js";

/**
 * عرض الطلب، مشترك بين "طلباتي" (orders.html) و"تتبّع طلبك" (track.html).
 *
 *   - شريط المراحل: قيد المراجعة ← تم التأكيد ← في الطريق ← تم التوصيل.
 *   - السطور، والخصومات والضرائب (adjustments)، والتوصيل، والإجمالي، والمسترجع.
 *   - التوصيل: اسم المندوب وهاتفه حين يكون الطلب معه (GET /orders/:id/delivery).
 *   - السجل الزمني: كل ما حدث للطلب بالترتيب (GET /orders/:id/events).
 *   - بطاقة لم تُدفع بعد: رابط "ادفع الآن" قبل انتهاء المهلة.
 */
const STEPS = ["pending", "confirmed", "shipped", "delivered"];

/** يجلب السجل الزمني والتوصيل لطلب. phone للضيف (التتبع بدون حساب). */
export async function loadOrderExtras(order, phone) {
  const q = phone ? `?phone=${encodeURIComponent(phone)}` : "";
  const [events, delivery] = await Promise.all([
    api(`/orders/${order.id}/events${q}`).catch(() => []),
    // التوصيل يُنشأ عند إسناد الطلب لمندوب (والإسناد يؤكده)، فلا نسأل عنه قبل ذلك.
    ["confirmed", "shipped", "delivered"].includes(order.status) ? api(`/orders/${order.id}/delivery${q}`).catch(() => null) : null,
  ]);
  return { events, delivery };
}

export function orderCard(order, extras = {}) {
  const { events = [], delivery = null } = extras;
  const reached = STEPS.indexOf(order.status);
  const progress =
    order.status === "cancelled"
      ? `<div class="alert error">تم إلغاء هذا الطلب.</div>`
      : `<div class="steps">${STEPS.map((s, i) => `<div class="step ${i <= reached ? "done" : ""}">${ORDER_STATUS[s]}</div>`).join("")}</div>`;
  const payNow =
    order.paymentMethod === "card" && ["pending", "failed"].includes(order.paymentStatus) && order.status === "pending"
      ? `<div class="alert info">لم يكتمل الدفع بعد${order.paymentExpiresAt ? ` (المهلة حتى ${esc(formatDate(order.paymentExpiresAt))})` : ""}.
         <a class="btn btn-sm" href="pay.html?order=${encodeURIComponent(order.id)}&phone=${encodeURIComponent(order.contactPhone)}">ادفع الآن</a></div>`
      : "";

  return `
    <article class="order-card" data-order="${esc(order.id)}">
      <div class="head">
        <span>طلب <span class="order-id">${esc(order.id)}</span></span>
        <span class="status ${esc(order.status)}">${esc(ORDER_STATUS[order.status] ?? order.status)}</span>
      </div>
      <div class="muted">${esc(formatDate(order.createdAt))}</div>
      ${progress}
      ${payNow}
      ${delivery ? `
      <div class="delivery-box">${icon("truck", 20)}
        <div><b>${esc(DELIVERY_STATUS[delivery.status] ?? delivery.status)}</b>
          ${delivery.courierName ? `<span>المندوب: ${esc(delivery.courierName)}${delivery.courierPhone && delivery.status === "picked_up" ? ` — <a class="ltr" href="tel:${esc(delivery.courierPhone)}">${esc(delivery.courierPhone)}</a>` : ""}</span>` : ""}
          ${delivery.status === "failed" && delivery.note ? `<span class="muted">${esc(delivery.note)}</span>` : ""}
        </div></div>` : ""}
      <table class="items-table">
        ${order.items.map((i) => `<tr><td>${esc(i.productName)}${i.variantTitle ? ` (${esc(i.variantTitle)})` : ""} × ${i.quantity}</td><td>${money(i.lineTotal)}</td></tr>`).join("")}
        ${(order.adjustments ?? []).map((a) => `<tr class="adjustment ${esc(a.type)}"><td>${esc(a.type === "discount" ? `خصم ${a.code.replace(/^COUPON:/, "")}` : a.label)}</td><td>${a.type === "discount" ? "−" : "+"}${money(a.amount)}</td></tr>`).join("")}
        <tr><td>التوصيل${order.shippingCity ? ` إلى ${esc(order.shippingCity)}` : ""}</td><td>${order.shippingCost === 0 ? "مجاناً" : money(order.shippingCost)}</td></tr>
        <tr><td><b>الإجمالي</b></td><td><b>${money(order.total)}</b></td></tr>
        ${order.refundedTotal > 0 ? `<tr class="adjustment discount"><td>المبلغ المسترجع</td><td>${money(order.refundedTotal)}</td></tr>` : ""}
      </table>
      <p class="muted">الدفع: ${esc(PAYMENT_STATUS[order.paymentStatus] ?? order.paymentStatus)} — العنوان: ${esc(order.shippingAddress)}</p>
      ${events.length ? `
      <details class="timeline-box" open>
        <summary>سجل الطلب</summary>
        <ol class="timeline">${events.map((e) => `<li><span class="when">${esc(formatDate(e.at))}</span><span>${esc(timelineText(e))}</span>${e.note && e.note !== "payment_expired" ? `<span class="muted">${esc(e.note)}</span>` : ""}</li>`).join("")}</ol>
      </details>` : ""}
    </article>`;
}
