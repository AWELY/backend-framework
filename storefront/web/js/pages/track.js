// صفحة "تتبّع طلبك" (track.html): الضيف يرى طلبه برقم الطلب ورقم الهاتف، دون حساب.
// تفتح مباشرة إن جاء الرابط بالرقمين (track.html?id=...&phone=...)، كالرابط في صفحة النجاح.
import { api, ApiError } from "../api.js";
import { mountLayout, esc, errorText, qs } from "../ui.js";
import { orderCard } from "../order-view.js";

mountLayout("track");
const app = document.getElementById("app");

// قيم الرابط تمر عبر esc، لأن أي شخص يستطيع كتابة رابط فيه HTML ويرسله لغيره.
// (اسم الحقل orderId وليس id: حقل اسمه id كان يخفي خاصية id للنموذج نفسه، خطأ سابق في جدول 6.5.)
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

/** يطلب الطلب من الـ API برقمه، مع الهاتف في الاستعلام (?phone=)، ويعرضه كبطاقة. */
async function track() {
  const id = form.orderId.value.trim();
  const phone = form.phone.value.trim();
  if (!id || !phone) {
    result.innerHTML = `<div class="alert error">أدخل رقم الطلب ورقم الهاتف.</div>`;
    return;
  }
  result.innerHTML = `<div class="loading">جاري البحث...</div>`;
  try {
    const order = await api(`/orders/${encodeURIComponent(id)}?phone=${encodeURIComponent(phone)}`);
    result.innerHTML = orderCard(order);
  } catch (err) {
    // الـ API يرد 404 في الحالتين، "لا يوجد طلب" و"الهاتف خطأ"، عمداً: لا يكشف أن رقم
    // الطلب صحيح إن كان الهاتف خاطئاً. لذلك رسالتنا واحدة للحالتين.
    result.innerHTML = `<div class="alert error">${
      err instanceof ApiError && err.status === 404 ? "لم نجد طلباً بهذا الرقم وهذا الهاتف. تأكد من البيانات." : esc(errorText(err))
    }</div>`;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  track();
});
// الرابط جاء بالرقمين: نتتبع مباشرة دون انتظار الضغط.
if (qs("id") && qs("phone")) track();
