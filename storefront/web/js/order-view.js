import { esc, money, formatDate, ORDER_STATUS, PAYMENT_STATUS } from "./ui.js";

const STEPS = ["pending", "confirmed", "shipped", "delivered"];

/** One order as a card with a progress bar - shared by "My orders" and "Track your order". */
export function orderCard(order) {
  const reached = STEPS.indexOf(order.status);
  const progress =
    order.status === "cancelled"
      ? `<div class="alert error">تم إلغاء هذا الطلب.</div>`
      : `<div class="steps">${STEPS.map((s, i) => `<div class="step ${i <= reached ? "done" : ""}">${ORDER_STATUS[s]}</div>`).join("")}</div>`;

  return `
    <article class="order-card">
      <div class="head">
        <span>طلب <span class="order-id">${esc(order.id)}</span></span>
        <span class="status ${esc(order.status)}">${esc(ORDER_STATUS[order.status] ?? order.status)}</span>
      </div>
      <div class="muted">${esc(formatDate(order.createdAt))}</div>
      ${progress}
      <table class="items-table">
        ${order.items.map((i) => `<tr><td>${esc(i.productName)} × ${i.quantity}</td><td>${money(i.lineTotal)}</td></tr>`).join("")}
        <tr><td>التوصيل${order.shippingCity ? ` إلى ${esc(order.shippingCity)}` : ""}</td><td>${order.shippingCost === 0 ? "مجاناً" : money(order.shippingCost)}</td></tr>
        <tr><td><b>الإجمالي</b></td><td><b>${money(order.total)}</b></td></tr>
      </table>
      <p class="muted">الدفع: ${esc(PAYMENT_STATUS[order.paymentStatus] ?? order.paymentStatus)} — العنوان: ${esc(order.shippingAddress)}</p>
    </article>`;
}
