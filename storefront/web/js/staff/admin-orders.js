import { esc, money, errorText, toast, formatDate, timelineText, ORDER_STATUS, PAYMENT_STATUS, DELIVERY_STATUS } from "../ui.js";
import { newKey } from "../api.js";
import { can, sapi, sapiPage, modal, pill, showMessage, toDirhams, toDinars } from "./common.js";

/**
 * الطلبات في لوحة الإدارة.
 *
 * ما يستخدمه من الإطار:
 *   - GET   /orders?status=&paymentStatus=&q=&limit=&offset=   والعدد في X-Total-Count
 *   - GET   /orders/:id و /orders/:id/events و /orders/:id/delivery و /orders/:id/refunds
 *   - PATCH /orders/:id/status (آلة الحالات: الخادم يرفض الانتقال غير المسموح بـ 409)
 *   - PATCH /orders/:id/payment (pending | paid | failed)
 *   - POST  /orders/:id/delivery (إسناد لمندوب من GET /staff?role=courier)
 *   - POST  /orders/:id/refunds مع Idempotency-Key (استرجاع جزئي، وإعادة كميات للمخزون)
 * الأزرار تظهر حسب صلاحية الدور، والخادم هو من يقرر في النهاية.
 */

const STATUS_NEXT = { pending: ["confirmed", "cancelled"], confirmed: ["shipped", "cancelled"], shipped: ["delivered"], delivered: [], cancelled: [] };
const PAYMENT_NEXT = { unpaid: ["pending", "paid", "failed"], pending: ["paid", "failed"], failed: ["pending", "paid"], paid: [], partially_refunded: [], refunded: [] };
const STATUS_COLOR = { pending: "amber", confirmed: "blue", shipped: "blue", delivered: "green", cancelled: "red" };
const PAYMENT_COLOR = { unpaid: "", pending: "amber", paid: "green", failed: "red", partially_refunded: "blue", refunded: "blue" };
const PAGE = 20;

export const statusPill = (s) => pill(ORDER_STATUS[s] ?? s, STATUS_COLOR[s]);
export const paymentPill = (s) => pill(PAYMENT_STATUS[s] ?? s, PAYMENT_COLOR[s]);

export async function ordersView(root, params) {
  const state = { status: params.get("status") ?? "", payment: params.get("payment") ?? "", q: params.get("q") ?? "", page: 1 };
  root.innerHTML = `
    <h1>الطلبات</h1>
    <div class="toolbar">
      <input type="search" placeholder="بحث: رقم الطلب، الاسم، الهاتف" data-q value="${esc(state.q)}">
      <select data-status><option value="">كل الحالات</option>${Object.entries(ORDER_STATUS).map(([k, v]) => `<option value="${k}" ${k === state.status ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select data-payment><option value="">كل حالات الدفع</option>${Object.entries(PAYMENT_STATUS).map(([k, v]) => `<option value="${k}" ${k === state.payment ? "selected" : ""}>${v}</option>`).join("")}</select>
      <span class="spacer"></span><span class="muted" data-count></span>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الطلب</th><th>التاريخ</th><th>الزبون</th><th>المدينة</th><th>الإجمالي</th><th>الحالة</th><th>الدفع</th></tr></thead><tbody data-rows></tbody></table></div>
    <div class="pager" data-pager></div>`;

  async function load() {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String((state.page - 1) * PAGE) });
    if (state.status) q.set("status", state.status);
    if (state.payment) q.set("paymentStatus", state.payment);
    if (state.q) q.set("q", state.q);
    const { items, total } = await sapiPage(`/orders?${q}`);
    root.querySelector("[data-count]").textContent = `${total} طلب`;
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((o) => `<tr class="clickable" data-open="${esc(o.id)}">
          <td class="ltr">${esc(o.id.slice(0, 8))}</td><td>${esc(formatDate(o.createdAt))}</td><td>${esc(o.contactName)}<br><span class="muted ltr">${esc(o.contactPhone)}</span></td>
          <td>${esc(o.shippingCity ?? "—")}</td><td class="num">${money(o.total)}</td><td>${statusPill(o.status)}</td><td>${paymentPill(o.paymentStatus)}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty-row">لا توجد طلبات مطابقة</td></tr>`;
    root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => openOrder(r.dataset.open, load)));
    const pages = Math.ceil(total / PAGE);
    root.querySelector("[data-pager]").innerHTML = pages > 1
      ? `${state.page > 1 ? `<a href="#" data-go="${state.page - 1}">السابق</a>` : ""}<span>صفحة ${state.page} من ${pages}</span>${state.page < pages ? `<a href="#" data-go="${state.page + 1}">التالي</a>` : ""}`
      : "";
    root.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => ((e.preventDefault(), (state.page = Number(a.dataset.go))), load())));
  }

  let timer;
  root.querySelector("[data-q]").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => ((state.q = e.target.value.trim()), (state.page = 1), load()), 300);
  });
  root.querySelector("[data-status]").addEventListener("change", (e) => ((state.status = e.target.value), (state.page = 1), load()));
  root.querySelector("[data-payment]").addEventListener("change", (e) => ((state.payment = e.target.value), (state.page = 1), load()));
  await load();
}

/** نافذة تفاصيل الطلب مع كل الإجراءات. onChange: يعيد تحميل القائمة بعد أي تغيير. */
export async function openOrder(id, onChange) {
  const { el, close } = modal("تفاصيل الطلب", `<div class="loading">جاري التحميل...</div>`);
  const body = el.querySelector(".modal-body");

  async function render() {
    const order = await sapi(`/orders/${id}`);
    const [events, delivery, refunds, couriers] = await Promise.all([
      sapi(`/orders/${id}/events`),
      ["confirmed", "shipped", "delivered", "cancelled"].includes(order.status) ? sapi(`/orders/${id}/delivery`).catch(() => null) : null,
      can("orders:read-all") ? sapi(`/orders/${id}/refunds`).catch(() => []) : [],
      can("orders:assign") ? sapiPage("/staff?role=courier&limit=100").then((p) => p.items.filter((s) => s.isActive)).catch(() => []) : [],
    ]);
    const refundable = order.total - order.refundedTotal;
    const canRefund = can("orders:refund") && ["paid", "partially_refunded"].includes(order.paymentStatus) && refundable > 0;
    const canAssign = can("orders:assign") && ["pending", "confirmed", "shipped"].includes(order.status) && !["picked_up", "delivered"].includes(delivery?.status);

    body.innerHTML = `
      <div data-msg></div>
      <div class="actions-row">${statusPill(order.status)} ${paymentPill(order.paymentStatus)} <span class="muted ltr">${esc(order.id)}</span></div>
      <dl class="kv section-box">
        <dt>الزبون</dt><dd>${esc(order.contactName)} — <a class="ltr" href="tel:${esc(order.contactPhone)}">${esc(order.contactPhone)}</a></dd>
        <dt>العنوان</dt><dd>${esc(order.shippingCity ? `${order.shippingCity} — ` : "")}${esc(order.shippingAddress)}</dd>
        <dt>الشحن</dt><dd>${esc(order.shippingMethod ?? "—")}</dd>
        <dt>الدفع</dt><dd>${esc(order.paymentMethod ?? "—")}${order.paymentReference ? ` <span class="muted ltr">(${esc(order.paymentReference)})</span>` : ""}${order.paymentExpiresAt ? ` — المهلة حتى ${esc(formatDate(order.paymentExpiresAt))}` : ""}</dd>
        <dt>التاريخ</dt><dd>${esc(formatDate(order.createdAt))}</dd>
      </dl>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>المنتج</th><th>SKU</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead>
        <tbody>${order.items.map((i) => `<tr><td>${esc(i.productName)}${i.variantTitle ? ` (${esc(i.variantTitle)})` : ""}${i.restockedQuantity ? ` ${pill(`أُعيد ${i.restockedQuantity}`, "blue")}` : ""}</td>
          <td class="ltr">${esc(i.sku ?? "—")}</td><td class="num">${money(i.unitPrice)}</td><td>${i.quantity}</td><td class="num">${money(i.lineTotal)}</td></tr>`).join("")}
          <tr><td colspan="4">المجموع</td><td class="num">${money(order.subtotal)}</td></tr>
          ${order.adjustments.map((a) => `<tr><td colspan="4">${esc(a.label)} <span class="muted ltr">${esc(a.code)}</span></td><td class="num">${a.type === "discount" ? "−" : "+"}${money(a.amount)}</td></tr>`).join("")}
          <tr><td colspan="4">التوصيل</td><td class="num">${money(order.shippingCost)}</td></tr>
          <tr><td colspan="4"><b>الإجمالي</b></td><td class="num"><b>${money(order.total)}</b></td></tr>
          ${order.refundedTotal ? `<tr><td colspan="4">المسترجع</td><td class="num">${money(order.refundedTotal)}</td></tr>` : ""}
        </tbody></table></div>

      ${can("orders:write") && (STATUS_NEXT[order.status].length || PAYMENT_NEXT[order.paymentStatus].length) ? `
      <div class="section-box"><h3>الإجراءات</h3>
        <div class="field"><input data-note placeholder="ملاحظة على التغيير (اختياري، تظهر في السجل)" maxlength="500"></div>
        <div class="actions-row">
          ${STATUS_NEXT[order.status].map((s) => `<button class="btn ${s === "cancelled" ? "btn-light" : ""}" data-status="${s}">${s === "cancelled" ? "إلغاء الطلب" : `تغيير إلى: ${ORDER_STATUS[s]}`}</button>`).join("")}
          ${PAYMENT_NEXT[order.paymentStatus].map((s) => `<button class="btn btn-light" data-payment="${s}">الدفع: ${PAYMENT_STATUS[s]}</button>`).join("")}
        </div></div>` : ""}

      <div class="section-box"><h3>التوصيل</h3>
        ${delivery ? `<p>${pill(DELIVERY_STATUS[delivery.status], delivery.status === "failed" ? "red" : delivery.status === "delivered" ? "green" : "blue")}
          المندوب: <b>${esc(delivery.courierName ?? "—")}</b>${delivery.attempts ? ` — محاولات فاشلة: ${delivery.attempts}` : ""}${delivery.note ? `<br><span class="muted">${esc(delivery.note)}</span>` : ""}</p>` : `<p class="muted">لم يُسند لمندوب بعد.</p>`}
        ${canAssign ? `
        <div class="toolbar"><select data-courier>${couriers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.phone ?? "")})</option>`).join("") || `<option value="">لا يوجد مندوبون</option>`}</select>
          <button class="btn" data-assign ${couriers.length ? "" : "disabled"}>${delivery ? "إعادة الإسناد" : "إسناد"}</button></div>` : ""}
      </div>

      ${refunds.length || canRefund ? `
      <div class="section-box"><h3>الاسترجاع</h3>
        ${refunds.map((r) => `<p>${pill(r.status === "succeeded" ? "نجح" : r.status === "failed" ? "فشل" : "قيد التنفيذ", r.status === "succeeded" ? "green" : r.status === "failed" ? "red" : "amber")}
          ${money(r.amount)} — ${esc(formatDate(r.createdAt))}${r.reason ? ` — ${esc(r.reason)}` : ""}${r.reference ? ` <span class="muted ltr">${esc(r.reference)}</span>` : ""}</p>`).join("")}
        ${canRefund ? `
        <form data-refund novalidate>
          <div class="form-grid">
            <div class="field"><label>المبلغ (دينار، المتبقي ${toDinars(refundable)})</label><input name="amount" type="number" step="0.001" min="0.001" max="${toDinars(refundable)}" class="ltr" value="${toDinars(refundable)}"></div>
            <div class="field"><label>السبب</label><input name="reason" maxlength="500" placeholder="مثال: إرجاع قطعة تالفة"></div>
          </div>
          <p class="muted">إعادة كميات إلى المخزون (اختياري):</p>
          ${order.items.filter((i) => i.productId && i.quantity > i.restockedQuantity).map((i, n) => `
            <label class="check-line"><input type="number" min="0" max="${i.quantity - i.restockedQuantity}" value="0" data-restock="${n}" data-product="${esc(i.productId)}" data-variant="${esc(i.variantId ?? "")}">
              ${esc(i.productName)}${i.variantTitle ? ` (${esc(i.variantTitle)})` : ""} <span class="muted">من ${i.quantity - i.restockedQuantity}</span></label>`).join("")}
          <button class="btn btn-dark">تنفيذ الاسترجاع</button>
        </form>` : ""}
      </div>` : ""}

      <div class="section-box"><h3>سجل الطلب</h3>
        <ol class="timeline">${events.map((e) => `<li><span class="when">${esc(formatDate(e.at))} — ${esc(e.actorType)}</span><span>${esc(timelineText(e))}</span>${e.note ? `<span class="muted">${esc(e.note)}</span>` : ""}</li>`).join("")}</ol>
      </div>`;

    const act = async (fn, success) => {
      showMessage(el, null);
      try {
        await fn();
        toast(success);
        onChange?.();
        await render();
      } catch (err) {
        showMessage(el, errorText(err));
      }
    };
    const note = () => body.querySelector("[data-note]")?.value.trim() || undefined;
    body.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", () => act(() => sapi(`/orders/${id}/status`, { method: "PATCH", body: { status: b.dataset.status, ...(note() ? { note: note() } : {}) } }), "تم تغيير الحالة"))
    );
    body.querySelectorAll("[data-payment]").forEach((b) =>
      b.addEventListener("click", () => act(() => sapi(`/orders/${id}/payment`, { method: "PATCH", body: { status: b.dataset.payment } }), "تم تسجيل الدفع"))
    );
    body.querySelector("[data-assign]")?.addEventListener("click", () =>
      act(() => sapi(`/orders/${id}/delivery`, { method: "POST", body: { courierId: body.querySelector("[data-courier]").value } }), "تم الإسناد للمندوب")
    );
    const refundForm = body.querySelector("[data-refund]");
    if (refundForm) {
      // مفتاح لهذا النموذج: ضغطتان سريعتان على "تنفيذ" لا تسترجعان المبلغ مرتين.
      const key = newKey();
      refundForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const restock = [...refundForm.querySelectorAll("[data-restock]")]
          .map((input) => ({ productId: input.dataset.product, variantId: input.dataset.variant || null, quantity: Number(input.value) }))
          .filter((r) => r.quantity > 0);
        act(
          () => sapi(`/orders/${id}/refunds`, {
            method: "POST",
            idempotencyKey: key,
            body: { amount: toDirhams(refundForm.amount.value), ...(refundForm.reason.value.trim() ? { reason: refundForm.reason.value.trim() } : {}), ...(restock.length ? { restock } : {}) },
          }),
          "تم الاسترجاع"
        );
      });
    }
  }

  try {
    await render();
  } catch (err) {
    body.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
  }
  return close;
}
