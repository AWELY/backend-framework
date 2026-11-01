import { apiPage } from "../api.js";
import { getToken } from "../store.js";
import { mountLayout, esc, errorText, qs } from "../ui.js";
import { orderCard, loadOrderExtras } from "../order-view.js";

/**
 * طلباتي (للزبون الداخل): GET /orders يرجع طلباته فقط، صفحة بعد صفحة (X-Total-Count)،
 * ولكل طلب سجله الزمني وحالة توصيله.
 */
mountLayout("account");
const app = document.getElementById("app");
const PAGE_SIZE = 10;
const page = Math.max(1, Number(qs("page")) || 1);

async function load() {
  if (!getToken()) {
    location.href = "account.html?next=orders.html";
    return;
  }
  const { items: orders, total } = await apiPage(`/orders?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`);
  const extras = await Promise.all(orders.map((o) => loadOrderExtras(o)));
  const pages = Math.ceil(total / PAGE_SIZE);
  app.innerHTML = `
    <h1 class="page-title">طلباتي <span class="muted">(${total})</span></h1>
    ${orders.length === 0
      ? `<div class="panel empty"><div class="big">لا توجد طلبات بعد</div><a class="btn" href="index.html">ابدأ التسوق</a></div>`
      : orders.map((o, i) => orderCard(o, extras[i])).join("")}
    ${pages > 1 ? `<nav class="pager">${page > 1 ? `<a href="orders.html?page=${page - 1}">السابق</a>` : ""}<span>صفحة ${page} من ${pages}</span>${page < pages ? `<a href="orders.html?page=${page + 1}">التالي</a>` : ""}</nav>` : ""}
    <p><a class="btn btn-light" href="account.html">بيانات حسابي</a></p>`;
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل الطلبات</div><p>${esc(errorText(err))}</p></div>`;
});
