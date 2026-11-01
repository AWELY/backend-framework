// صفحة "طلباتي" (orders.html): طلبات الزبون المسجل دخوله فقط.
// الـ API يصفّي الطلبات برقم الزبون من التوكن نفسه، فلا يستطيع زبون رؤية طلبات غيره.
import { api } from "../api.js";
import { getToken } from "../store.js";
import { mountLayout, esc, errorText } from "../ui.js";
import { orderCard } from "../order-view.js";

mountLayout("account");
const app = document.getElementById("app");

async function load() {
  // غير مسجل: إلى صفحة الدخول، ثم العودة إلى هنا (?next=orders.html).
  if (!getToken()) {
    location.href = "account.html?next=orders.html";
    return;
  }
  const orders = await api("/orders");
  // orders.map(orderCard) تحوّل كل طلب إلى بطاقة HTML (من order-view.js).
  app.innerHTML = `
    <h1 class="page-title">طلباتي</h1>
    ${orders.length === 0
      ? `<div class="panel empty"><div class="big">لا توجد طلبات بعد</div><a class="btn" href="index.html">ابدأ التسوق</a></div>`
      : orders.map(orderCard).join("")}
    <p><a class="btn btn-light" href="account.html">بيانات حسابي</a></p>`;
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل الطلبات</div><p>${esc(errorText(err))}</p></div>`;
});
