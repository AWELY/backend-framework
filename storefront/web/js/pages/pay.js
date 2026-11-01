import { api } from "../api.js";
import { mountLayout, esc, money, errorText, qs, icon, formatDate } from "../ui.js";

/**
 * صفحة "البنك" التجريبية لبوابة البطاقة (إضافة demo-card-gateway في api/plugins).
 * في بوابة حقيقية هذه الصفحة عند البوابة نفسها. هنا: المشتري يختار نجاح الدفع أو رفض البطاقة،
 * فترسل "خوادم البنك" webhook موقّعاً للمتجر، ويتحدث الطلب (والمخزون يبقى محجوزاً حتى المهلة).
 */
mountLayout("checkout");
const app = document.getElementById("app");
const orderId = qs("order") ?? "";
const phone = qs("phone") ?? "";
const trackUrl = `track.html?id=${encodeURIComponent(orderId)}&phone=${encodeURIComponent(phone)}`;

async function load() {
  const order = await api(`/orders/${encodeURIComponent(orderId)}?phone=${encodeURIComponent(phone)}`, { auth: "none" });
  if (order.paymentStatus === "paid") {
    location.href = trackUrl;
    return;
  }
  app.innerHTML = `
    <div class="panel narrow pay-card">
      <div class="pay-brand">${icon("shield", 28)} <b>بوابة الدفع التجريبية</b></div>
      <p class="muted">هذه صفحة تجريبية تقوم مقام صفحة البنك. لا تُدخل بيانات بطاقة حقيقية.</p>
      <div class="pay-amount">${money(order.total)}</div>
      <p>طلب <span class="order-id">${esc(order.id.slice(0, 8))}</span>${order.paymentExpiresAt ? ` — أكمل الدفع قبل ${esc(formatDate(order.paymentExpiresAt))}` : ""}</p>
      <div class="field"><label for="card">رقم البطاقة</label><input id="card" class="ltr" value="4242 4242 4242 4242" inputmode="numeric"></div>
      <div data-msg></div>
      <button class="btn btn-block btn-lg" data-outcome="paid">ادفع ${money(order.total)}</button>
      <button class="btn btn-light btn-block" data-outcome="failed">محاكاة رفض البطاقة</button>
      <a class="btn btn-ghost btn-block" href="${trackUrl}">لاحقاً</a>
    </div>`;
  app.querySelectorAll("[data-outcome]").forEach((b) =>
    b.addEventListener("click", async () => {
      app.querySelectorAll("[data-outcome]").forEach((x) => (x.disabled = true));
      try {
        const result = await api("/payments/card/simulate", { method: "POST", auth: "none", body: { orderId, phone, outcome: b.dataset.outcome } });
        if (result.paymentStatus === "paid") location.href = trackUrl;
        else {
          app.querySelector("[data-msg]").innerHTML = `<div class="alert error">رُفضت البطاقة. جرّب مرة أخرى قبل انتهاء المهلة.</div>`;
          app.querySelectorAll("[data-outcome]").forEach((x) => (x.disabled = false));
        }
      } catch (err) {
        app.querySelector("[data-msg]").innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
        app.querySelectorAll("[data-outcome]").forEach((x) => (x.disabled = false));
      }
    })
  );
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر فتح صفحة الدفع</div><p>${esc(errorText(err))}</p><a class="btn" href="${trackUrl}">تتبّع الطلب</a></div>`;
});
