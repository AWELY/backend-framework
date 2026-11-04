// صفحة الزبائن في لوحة التحكم (admin/customers.html): الزبائن المسجلون، مع عدد طلبات كل زبون
// ومجموع مشترياته وآخر طلب.
//
// القائمة من مسار الإطار GET /customers (صلاحية customers:read)، والإحصاءات من إضافة التقارير
// GET /admin/customer-stats، واللوحة تدمج الاثنين برقم الزبون. (الضيوف ليسوا هنا: الضيف لا حساب
// له، وبياناته في طلبه فقط.)
import { requireAdmin, mountAdmin, staffApi, esc, money, formatDate, errorText, showLoadError, timeAgo } from "../common.js";

const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, { active: "customers", title: "الزبائن" });
  load().catch((err) => showLoadError(content, errorText(err)));
}

async function load() {
  const [customers, stats] = await Promise.all([staffApi("/customers?limit=100"), staffApi("/admin/customer-stats")]);
  const statOf = new Map(stats.map((s) => [s.customerId, s]));
  const sorts = {
    recent: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    spent: (a, b) => (statOf.get(b.id)?.spent ?? 0) - (statOf.get(a.id)?.spent ?? 0),
    orders: (a, b) => (statOf.get(b.id)?.orders ?? 0) - (statOf.get(a.id)?.orders ?? 0),
  };
  const state = { search: "", sort: "recent" };

  content.innerHTML = `
    <section class="box">
      <div class="toolbar">
        <input type="search" placeholder="ابحث بالاسم أو البريد أو الهاتف" aria-label="بحث" data-search>
        <select aria-label="الترتيب" data-sort>
          <option value="recent">الأحدث تسجيلاً</option>
          <option value="spent">الأكثر شراءً</option>
          <option value="orders">الأكثر طلبات</option>
        </select>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>الزبون</th><th>الهاتف</th><th>الطلبات</th><th>مجموع المشتريات</th><th>آخر طلب</th><th>سجّل في</th></tr></thead>
        <tbody data-rows></tbody>
      </table></div>
      <div class="pager"><span data-count></span><span class="muted">الضيوف (بلا حساب) يظهرون في صفحة الطلبات فقط.</span></div>
    </section>`;

  const rows = content.querySelector("[data-rows]");
  const paint = () => {
    const term = state.search.trim().toLowerCase();
    const shown = customers
      .filter((c) => !term || `${c.name} ${c.email} ${c.phone ?? ""}`.toLowerCase().includes(term))
      .sort(sorts[state.sort]);
    content.querySelector("[data-count]").textContent = `${shown.length} زبون`;
    rows.innerHTML = shown.length ? shown.map((c) => {
      const s = statOf.get(c.id);
      return `<tr>
        <td><b>${esc(c.name)}</b><span class="sub ltr">${esc(c.email)}</span></td>
        <td class="ltr">${c.phone ? `<a class="row-link" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>` : "—"}</td>
        <td class="n">${s?.orders ?? 0}</td>
        <td class="n">${money(s?.spent ?? 0)}</td>
        <td class="muted">${s?.lastOrderAt ? esc(timeAgo(s.lastOrderAt)) : "—"}</td>
        <td class="muted">${esc(formatDate(c.createdAt))}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="empty-row">${term ? "لا نتائج" : "لا زبائن مسجلين بعد"}</td></tr>`;
  };
  paint();
  content.querySelector("[data-search]").addEventListener("input", (e) => { state.search = e.target.value; paint(); });
  content.querySelector("[data-sort]").addEventListener("change", (e) => { state.sort = e.target.value; paint(); });
}
