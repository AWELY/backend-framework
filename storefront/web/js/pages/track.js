import { api, ApiError } from "../api.js";
import { mountLayout, esc, errorText, qs } from "../ui.js";
import { orderCard, loadOrderExtras } from "../order-view.js";

/**
 * تتبّع الطلب دون حساب: رقم الطلب + رقم الهاتف المستخدم فيه (شرطان معاً، فلا يرى أحد طلب غيره).
 * يعرض الطلب، وسجله الزمني، والمندوب حين يكون الطلب معه.
 */
mountLayout("track");
const app = document.getElementById("app");

app.innerHTML = `
  <h1 class="page-title">تتبّع طلبك</h1>
  <form class="panel narrow" data-form novalidate>
    <p class="muted">أدخل رقم الطلب ورقم الهاتف الذي استخدمته عند الطلب.</p>
    <div class="field"><label for="orderId">رقم الطلب</label><input id="orderId" name="orderId" class="ltr" required value="${esc(qs("id") ?? "")}"></div>
    <div class="field"><label for="phone">رقم الهاتف</label><input id="phone" name="phone" type="tel" class="ltr" required value="${esc(qs("phone") ?? "")}"></div>
    <button class="btn btn-block">تتبّع</button>
  </form>
  <div class="narrow" data-result></div>`;

const form = app.querySelector("[data-form]");
const result = app.querySelector("[data-result]");

async function track() {
  const id = form.orderId.value.trim();
  const phone = form.phone.value.trim();
  if (!id || !phone) {
    result.innerHTML = `<div class="alert error">أدخل رقم الطلب ورقم الهاتف.</div>`;
    return;
  }
  result.innerHTML = `<div class="loading">جاري البحث...</div>`;
  try {
    const order = await api(`/orders/${encodeURIComponent(id)}?phone=${encodeURIComponent(phone)}`, { auth: "none" });
    result.innerHTML = orderCard(order, await loadOrderExtras(order, phone));
  } catch (err) {
    result.innerHTML = `<div class="alert error">${
      err instanceof ApiError && err.status === 404 ? "لم نجد طلباً بهذا الرقم وهذا الهاتف. تأكد من البيانات." : esc(errorText(err))
    }</div>`;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  track();
});
if (qs("id") && qs("phone")) track();
