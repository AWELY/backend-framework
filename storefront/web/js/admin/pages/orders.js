// صفحة الطلبات في لوحة التحكم (admin/orders.html): تبويبات حسب الحالة، وبحث، وترقيم صفحات،
// والمندوب المعيّن لكل طلب.
//
// القائمة نفسها من مسار الإطار GET /orders?status=&limit=&offset= (المدير يرى كل الطلبات لأن
// دوره يملك orders:read-all). والمندوب لكل طلب من إضافة التوصيل GET /deliveries?orderIds=...
// بطلب واحد لكل الصفحة، لا طلب لكل صف.
import { requireAdmin, mountAdmin, staffApi, esc, icon, money, errorText, showLoadError, statusChip, shortId, timeAgo, qs, STATUS_SHORT, PAYMENT, refreshPendingCount } from "../common.js";

// 25 طلباً في الصفحة. الإطار يقبل حتى 100.
const PAGE = 25;

const session = requireAdmin();
if (session) {
  const content = mountAdmin(session, {
    active: "orders",
    title: "الطلبات",
    actions: `<button class="btn btn-sm btn-outline" data-refresh>${icon("refresh", 18)} تحديث</button>`,
  });
  // الحالة والصفحة من الرابط (?status=pending&page=2)، فيمكن مشاركة الرابط أو الرجوع إليه.
  const state = { status: qs("status") ?? "", page: Math.max(1, Number(qs("page")) || 1), search: "" };
  const render = () => load(content, state).catch((err) => showLoadError(content, errorText(err)));
  document.querySelector("[data-refresh]").addEventListener("click", () => {
    refreshPendingCount();
    render();
  });
  render();
}

async function load(content, state) {
  const offset = (state.page - 1) * PAGE;
  // نطلب صفاً واحداً زيادة (PAGE + 1) لنعرف إن كانت هناك صفحة تالية، دون طلب عدد إجمالي.
  const statusQuery = state.status ? `&status=${encodeURIComponent(state.status)}` : "";
  const [orders, summary] = await Promise.all([
    staffApi(`/orders?limit=${PAGE + 1}&offset=${offset}${statusQuery}`),
    staffApi("/admin/summary"),
  ]);
  const hasNext = orders.length > PAGE;
  const pageOrders = orders.slice(0, PAGE);
  const deliveries = pageOrders.length
    ? await staffApi(`/deliveries?orderIds=${pageOrders.map((o) => o.id).join(",")}`)
    : [];
  const courierOf = new Map(deliveries.map((d) => [d.orderId, d]));
  const total = Object.values(summary.byStatus).reduce((a, b) => a + b, 0);

  content.innerHTML = `
    <section class="box">
      <nav class="seg" aria-label="تصفية بالحالة">
        <a href="orders.html" class="${!state.status ? "active" : ""}">الكل<span class="c">${total}</span></a>
        ${Object.entries(STATUS_SHORT).map(([s, label]) =>
          `<a href="orders.html?status=${s}" class="${state.status === s ? "active" : ""}">${label}<span class="c">${summary.byStatus[s] ?? 0}</span></a>`).join("")}
      </nav>
      <div class="toolbar">
        <input type="search" placeholder="ابحث برقم الطلب أو اسم الزبون أو هاتفه أو المدينة" aria-label="بحث" value="${esc(state.search)}" data-search>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>الطلب</th><th>الزبون</th><th>التوصيل</th><th>المبلغ</th><th>الدفع</th><th>الحالة</th><th>المندوب</th><th></th></tr></thead>
        <tbody data-rows></tbody>
      </table></div>
      <div class="pager">
        <span>صفحة ${state.page}</span>
        <span class="action-row">
          <button class="btn btn-sm btn-light" data-page="-1" ${state.page === 1 ? "disabled" : ""}>السابقة</button>
          <button class="btn btn-sm btn-light" data-page="1" ${hasNext ? "" : "disabled"}>التالية</button>
        </span>
      </div>
    </section>`;

  const rows = content.querySelector("[data-rows]");
  /**
   * يرسم صفوف الجدول، مصفّاة بكلمة البحث. البحث هنا في الصفحة المعروضة فقط: الإطار لا يوفر
   * بحثاً نصياً في الطلبات (فرصة تحسين له). الهاتف يُقارن أرقاماً فقط، فـ "091 234" تجد "0912345678".
   */
  const paint = () => {
    const term = state.search.trim().toLowerCase();
    const digits = term.replace(/\D/g, "");
    const shown = term
      ? pageOrders.filter((o) =>
          `${o.id} ${o.contactName} ${o.shippingCity ?? ""}`.toLowerCase().includes(term) ||
          (digits.length >= 3 && o.contactPhone.replace(/\D/g, "").includes(digits)))
      : pageOrders;
    rows.innerHTML = shown.length
      ? shown.map((o) => row(o, courierOf.get(o.id))).join("")
      : `<tr><td colspan="8" class="empty-row">${term ? "لا نتائج في هذه الصفحة" : "لا توجد طلبات بهذه الحالة"}</td></tr>`;
  };
  paint();

  content.querySelector("[data-search]").addEventListener("input", (e) => {
    state.search = e.target.value;
    paint();
  });
  content.querySelectorAll("[data-page]").forEach((b) =>
    b.addEventListener("click", () => {
      state.page += Number(b.dataset.page);
      // نحدّث الرابط دون إعادة تحميل الصفحة (history.replaceState)، ثم نرسم الصفحة الجديدة.
      const params = new URLSearchParams();
      if (state.status) params.set("status", state.status);
      if (state.page > 1) params.set("page", String(state.page));
      const query = params.toString();
      history.replaceState(null, "", `orders.html${query ? `?${query}` : ""}`);
      load(content, state).catch((err) => showLoadError(content, errorText(err)));
    })
  );
}

/** صف طلب واحد. كل نص من الـ API يمر عبر esc. */
function row(o, delivery) {
  const url = `order.html?id=${encodeURIComponent(o.id)}`;
  // المندوب: اسمه، وتنبيه إن أبلغ عن مشكلة. الطلب المؤكد بلا مندوب (والتوصيل للمنزل) يحتاج تعييناً.
  const needsCourier = o.status === "confirmed" && o.shippingMethod !== "pickup" && !delivery;
  // ملاحظة المندوب تهم فقط ما دام الطلب لم يُسلَّم.
  const openNote = delivery?.note && !["delivered", "cancelled"].includes(o.status);
  const courier = delivery
    ? `${esc(delivery.courierName)}${openNote ? `<span class="flag">${icon("alert", 14)} ${esc(delivery.note)}</span>` : ""}`
    : needsCourier ? `<span class="flag">${icon("alert", 14)} يحتاج مندوباً</span>` : `<span class="muted">—</span>`;
  return `
    <tr>
      <td><a class="row-link n" href="${url}">${esc(shortId(o.id))}</a><span class="sub">${esc(timeAgo(o.createdAt))}</span></td>
      <td>${esc(o.contactName)}<span class="sub ltr">${esc(o.contactPhone)}</span></td>
      <td>${o.shippingMethod === "pickup" ? "استلام من المحل" : esc(o.shippingCity ?? "—")}<span class="sub">${o.items.reduce((n, i) => n + i.quantity, 0)} قطعة</span></td>
      <td class="n">${money(o.total)}</td>
      <td>${o.status === "cancelled" && o.paymentStatus !== "paid" ? `<span class="muted">—</span>` : statusChip(o.paymentStatus, PAYMENT)}</td>
      <td>${statusChip(o.status)}</td>
      <td>${courier}</td>
      <td><a class="btn btn-sm btn-light" href="${url}">فتح</a></td>
    </tr>`;
}
