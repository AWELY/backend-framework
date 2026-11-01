import { esc, money, errorText, toast, formatDate, DELIVERY_STATUS } from "../ui.js";
import { identity, renderLogin, topBar, sapi, sapiPage, isSessionError, modal, pill, showMessage, toDirhams, toDinars, logout } from "./common.js";

/**
 * تطبيق المندوب (الهاتف أولاً).
 *
 * ما يستخدمه من الإطار (وحدة التوصيل):
 *   - GET  /deliveries?status=           توصيلاته هو فقط (الخادم يقصرها عليه: deliveries:read-own)
 *   - POST /deliveries/:orderId/pickup   استلم الطلب من المحل (الطلب يصبح "في الطريق")
 *   - POST /deliveries/:orderId/deliver  سلّمه، مع المبلغ المحصّل (للدفع عند الاستلام يجب أن يساوي الإجمالي)
 *   - POST /deliveries/:orderId/fail     لم ينجح التوصيل، مع السبب (يعود للمشرف ليعيد إسناده)
 * كل خطوة تُكتب في سجل الطلب الزمني، فيراها الزبون في صفحة التتبع، ويصله إشعار (dev-mailbox).
 */
const app = document.getElementById("app");
let tab = "active";

function start() {
  const who = identity();
  if (!who) {
    renderLogin(app, { title: "تطبيق المندوب", allowedRoles: ["courier", "admin"], onSuccess: () => location.reload() });
    return;
  }
  document.body.prepend(topBar("تطبيق المندوب"));
  render();
  // تحديث تلقائي كل 30 ثانية: طلبات جديدة يسندها المشرف تظهر دون إعادة تحميل.
  setInterval(() => {
    if (!document.querySelector("dialog[open]")) render(true);
  }, 30_000);
}

async function render(quiet = false) {
  if (!quiet) app.innerHTML = `<div class="loading">جاري التحميل...</div>`;
  try {
    const statuses = tab === "active" ? ["assigned", "picked_up", "failed"] : ["delivered"];
    const pages = await Promise.all(statuses.map((s) => sapiPage(`/deliveries?status=${s}&limit=100`)));
    const jobs = pages.flatMap((p) => p.items);
    const order = { picked_up: 0, assigned: 1, failed: 2, delivered: 3 };
    jobs.sort((a, b) => order[a.status] - order[b.status] || new Date(a.assignedAt) - new Date(b.assignedAt));
    app.innerHTML = `
      <h1>توصيلاتي</h1>
      <div class="courier-tabs">
        <button type="button" data-tab="active" class="${tab === "active" ? "active" : ""}">الحالية</button>
        <button type="button" data-tab="done" class="${tab === "done" ? "active" : ""}">المسلّمة</button>
      </div>
      ${jobs.length === 0 ? `<div class="panel empty"><div class="big">${tab === "active" ? "لا توجد توصيلات الآن" : "لم تسلّم طلبات بعد"}</div><p class="muted">تُحدَّث القائمة تلقائياً.</p></div>` : jobs.map(jobCard).join("")}
      <button class="btn btn-light btn-block" data-refresh>تحديث</button>`;
    app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => ((tab = b.dataset.tab), render())));
    app.querySelector("[data-refresh]").addEventListener("click", () => render());
    app.querySelectorAll("[data-pickup]").forEach((b) => b.addEventListener("click", () => pickup(b.dataset.pickup)));
    app.querySelectorAll("[data-deliver]").forEach((b) => b.addEventListener("click", () => deliver(jobs.find((j) => j.orderId === b.dataset.deliver))));
    app.querySelectorAll("[data-fail]").forEach((b) => b.addEventListener("click", () => fail(b.dataset.fail)));
  } catch (err) {
    if (isSessionError(err)) return logout();
    app.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
  }
}

const isPaid = (job) => ["paid", "partially_refunded", "refunded"].includes(job.order.paymentStatus);

function jobCard(job) {
  const o = job.order;
  const color = { assigned: "blue", picked_up: "amber", delivered: "green", failed: "red" }[job.status];
  const address = `${o.shippingCity ? `${o.shippingCity} — ` : ""}${o.shippingAddress}`;
  return `
    <article class="job" data-job="${esc(job.orderId)}">
      <div class="job-head"><span class="who">${esc(o.contactName)}</span>${pill(DELIVERY_STATUS[job.status], color)}</div>
      <div class="addr">${esc(address)}</div>
      <div class="links">
        <a class="ltr" href="tel:${esc(o.contactPhone)}">${esc(o.contactPhone)}</a>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}" target="_blank" rel="noopener">الخريطة</a>
        <span class="muted">طلب ${esc(o.id.slice(0, 8))} — ${o.itemCount} قطعة</span>
      </div>
      <div class="collect ${isPaid(job) ? "paid" : ""}">${isPaid(job) ? "مدفوع مسبقاً — لا تحصيل" : `حصّل: ${money(o.total)}`}</div>
      ${job.note ? `<div class="muted">ملاحظة: ${esc(job.note)}</div>` : ""}
      ${job.status === "delivered" ? `<div class="muted">سُلّم ${esc(formatDate(job.deliveredAt))}${job.cashCollected ? ` — حُصّل ${money(job.cashCollected)}` : ""}</div>` : ""}
      ${job.status === "assigned" || job.status === "failed" ? `
      <div class="job-actions"><button class="btn" data-pickup="${esc(job.orderId)}">استلمت الطلب</button>
        ${job.status === "assigned" ? `<button class="btn btn-light" data-fail="${esc(job.orderId)}">تعذّر</button>` : ""}</div>` : ""}
      ${job.status === "picked_up" ? `
      <div class="job-actions"><button class="btn" data-deliver="${esc(job.orderId)}">تم التسليم</button>
        <button class="btn btn-light" data-fail="${esc(job.orderId)}">تعذّر التوصيل</button></div>` : ""}
    </article>`;
}

async function pickup(orderId) {
  try {
    await sapi(`/deliveries/${orderId}/pickup`, { method: "POST" });
    toast("تم تسجيل الاستلام. الزبون يرى أن الطلب في الطريق.");
    render(true);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

function deliver(job) {
  const paid = isPaid(job);
  const { el, close } = modal("تأكيد التسليم", `
    <div data-msg></div>
    <form novalidate>
      ${paid ? `<p class="alert info">الطلب مدفوع مسبقاً بالبطاقة. لا تحصّل أي مبلغ.</p>` : `
      <div class="field"><label for="cash">المبلغ المحصّل (دينار)</label>
        <input id="cash" name="cash" type="number" step="0.001" min="0" class="ltr" value="${toDinars(job.order.total)}" required></div>`}
      <div class="field"><label for="note">ملاحظة (اختياري)</label><input id="note" name="note" maxlength="500" placeholder="مثال: سُلّم للحارس"></div>
      <button class="btn btn-block btn-lg">تأكيد التسليم</button>
    </form>`);
  el.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await sapi(`/deliveries/${job.orderId}/deliver`, {
        method: "POST",
        body: { ...(paid ? {} : { cashCollected: toDirhams(form.cash.value) }), ...(form.note.value.trim() ? { note: form.note.value.trim() } : {}) },
      });
      close();
      toast("تم التسليم. شكراً!");
      render(true);
    } catch (err) {
      showMessage(el, errorText(err));
    }
  });
}

function fail(orderId) {
  const { el, close } = modal("تعذّر التوصيل", `
    <div data-msg></div>
    <form novalidate>
      <div class="field"><label for="reason">السبب</label>
        <select id="reason" name="reason">
          <option>الزبون لا يرد على الهاتف</option><option>العنوان غير صحيح</option><option>الزبون طلب التأجيل</option><option>رفض الزبون الاستلام</option><option value="">سبب آخر...</option>
        </select></div>
      <div class="field"><label for="other">تفاصيل</label><input id="other" name="other" maxlength="400"></div>
      <button class="btn btn-block">تسجيل المحاولة</button>
    </form>`);
  el.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const note = [form.reason.value, form.other.value.trim()].filter(Boolean).join(" — ");
    try {
      await sapi(`/deliveries/${orderId}/fail`, { method: "POST", body: { note } });
      close();
      toast("سُجّلت المحاولة. سيتواصل المشرف مع الزبون.");
      render(true);
    } catch (err) {
      showMessage(el, errorText(err));
    }
  });
}

start();
