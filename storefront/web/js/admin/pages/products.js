// صفحة المنتجات في لوحة التحكم (admin/products.html): كل المنتجات (ومنها المخفية) في جدول،
// مع تعديل المخزون مباشرة في الصف، ومفتاح الإظهار والإخفاء، والتعديل والحذف.
//
// مسارات الإطار: GET /products (المدير يرى غير النشطة أيضاً لأنه يملك products:write)،
// و PATCH /products/:id، و DELETE /products/:id، و PUT /inventory/:id.
// والكميات كلها بطلب واحد من إضافة التقارير (GET /admin/stock) بدل طلب لكل منتج.
import { requireAdmin, mountAdmin, staffApi, esc, icon, money, errorText, toast, showLoadError, PLACEHOLDER } from "../common.js";

const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, {
    active: "products",
    title: "المنتجات",
    actions: `<a class="btn btn-sm" href="product.html">${icon("plus", 18)} إضافة منتج</a>`,
  });
  load().catch((err) => showLoadError(content, errorText(err)));
}

// حالة التصفية، تبقى عند إعادة الرسم بعد أي تعديل.
const state = { search: "", category: "", stock: "" };

async function load() {
  const [products, categories, stock] = await Promise.all([
    staffApi("/products?limit=100"),
    staffApi("/categories?limit=100"),
    staffApi("/admin/stock"),
  ]);
  const quantity = new Map(stock.map((s) => [s.productId, s.quantity]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  content.innerHTML = `
    <section class="box">
      <div class="toolbar">
        <input type="search" placeholder="ابحث باسم المنتج" aria-label="بحث" value="${esc(state.search)}" data-search>
        <select aria-label="القسم" data-category>
          <option value="">كل الأقسام</option>
          ${categories.map((c) => `<option value="${esc(c.id)}" ${state.category === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        <select aria-label="المخزون" data-stock>
          <option value="">كل الكميات</option>
          <option value="low" ${state.stock === "low" ? "selected" : ""}>3 قطع أو أقل</option>
          <option value="out" ${state.stock === "out" ? "selected" : ""}>نفد</option>
          <option value="hidden" ${state.stock === "hidden" ? "selected" : ""}>المخفية عن الزبائن</option>
        </select>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th></th><th>المنتج</th><th>القسم</th><th>السعر</th><th>المخزون</th><th>ظاهر للزبائن</th><th></th></tr></thead>
        <tbody data-rows></tbody>
      </table></div>
      <div class="pager"><span data-count></span><span class="muted">تعديل الكمية: اكتب الرقم الجديد ثم اضغط Enter أو "حفظ".</span></div>
    </section>`;

  const rows = content.querySelector("[data-rows]");
  const paint = () => {
    const term = state.search.trim().toLowerCase();
    const shown = products.filter((p) => {
      const q = quantity.get(p.id) ?? 0;
      if (term && !`${p.name} ${p.slug}`.toLowerCase().includes(term)) return false;
      if (state.category && p.categoryId !== state.category) return false;
      if (state.stock === "low" && q > 3) return false;
      if (state.stock === "out" && q > 0) return false;
      if (state.stock === "hidden" && p.isActive) return false;
      return true;
    });
    content.querySelector("[data-count]").textContent = `${shown.length} من ${products.length} منتج`;
    rows.innerHTML = shown.length
      ? shown.map((p) => row(p, quantity.get(p.id) ?? 0, categoryName.get(p.categoryId))).join("")
      : `<tr><td colspan="7" class="empty-row">لا منتجات مطابقة</td></tr>`;
    bindRows(rows, products, quantity);
  };
  paint();

  content.querySelector("[data-search]").addEventListener("input", (e) => { state.search = e.target.value; paint(); });
  content.querySelector("[data-category]").addEventListener("change", (e) => { state.category = e.target.value; paint(); });
  content.querySelector("[data-stock]").addEventListener("change", (e) => { state.stock = e.target.value; paint(); });
}

/** صف منتج. حقل الكمية يحفظ قيمته الأصلية في data-original ليعرف إن تغيّر. */
function row(p, qty, category) {
  return `
    <tr class="${p.isActive ? "" : "inactive"}" data-id="${esc(p.id)}">
      <td><img class="thumb" src="${esc(p.imageUrl ?? PLACEHOLDER)}" alt="" loading="lazy"></td>
      <td><a class="row-link" href="product.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a><span class="sub ltr">${esc(p.slug)}</span></td>
      <td>${esc(category ?? "بلا قسم")}</td>
      <td class="n">${money(p.price)}</td>
      <td>
        <form class="inline-form" data-stock-form>
          <input class="stock-input" type="number" min="0" max="1000000" step="1" value="${qty}" data-original="${qty}" aria-label="كمية ${esc(p.name)}">
          <button class="btn btn-sm btn-light hidden">حفظ</button>
          ${qty === 0 ? `<span class="status cancelled">نفد</span>` : qty <= 3 ? `<span class="status pending">قليل</span>` : ""}
        </form>
      </td>
      <td><input type="checkbox" class="switch" ${p.isActive ? "checked" : ""} aria-label="إظهار ${esc(p.name)} للزبائن" data-active></td>
      <td><div class="action-row">
        <a class="btn btn-sm btn-light" href="product.html?id=${encodeURIComponent(p.id)}" aria-label="تعديل">${icon("edit", 16)}</a>
        <button class="btn btn-sm btn-danger" data-delete aria-label="حذف">${icon("trash", 16)}</button>
      </div></td>
    </tr>`;
}

/** يربط عناصر كل صف: حفظ الكمية، ومفتاح الإظهار، والحذف. */
function bindRows(rows, products, quantity) {
  rows.querySelectorAll("tr[data-id]").forEach((tr) => {
    const productId = tr.dataset.id;
    const product = products.find((p) => p.id === productId);

    // الكمية: زر "حفظ" يظهر فقط بعد تغيير الرقم. PUT /inventory يضبط الكمية إلى الرقم الجديد.
    const form = tr.querySelector("[data-stock-form]");
    const input = form.querySelector("input");
    const save = form.querySelector("button");
    input.addEventListener("input", () => {
      const changed = input.value !== input.dataset.original;
      input.classList.toggle("changed", changed);
      save.classList.toggle("hidden", !changed);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < 0) return toast("الكمية رقم صحيح من 0 فأكثر", "error");
      save.disabled = true;
      try {
        const result = await staffApi(`/inventory/${productId}`, { method: "PUT", body: { quantity: value } });
        quantity.set(productId, result.quantity);
        toast(`تم حفظ كمية "${product.name}": ${result.quantity}`);
        load().catch((err) => showLoadError(content, errorText(err)));
      } catch (err) {
        toast(errorText(err), "error");
        save.disabled = false;
      }
    });

    // الإظهار والإخفاء: PATCH بحقل واحد { isActive }. المخفي يختفي من المتجر فوراً دون حذفه.
    tr.querySelector("[data-active]").addEventListener("change", async (e) => {
      const isActive = e.target.checked;
      e.target.disabled = true;
      try {
        await staffApi(`/products/${productId}`, { method: "PATCH", body: { isActive } });
        product.isActive = isActive;
        tr.classList.toggle("inactive", !isActive);
        toast(isActive ? "المنتج ظاهر الآن في المتجر" : "أُخفي المنتج عن الزبائن");
      } catch (err) {
        e.target.checked = !isActive;
        toast(errorText(err), "error");
      } finally {
        e.target.disabled = false;
      }
    });

    // الحذف النهائي. الطلبات القديمة تحتفظ باسم المنتج وسعره (الإطار نسخهما وقت الشراء).
    tr.querySelector("[data-delete]").addEventListener("click", async (e) => {
      if (!confirm(`حذف "${product.name}" نهائياً؟\nإن أردت إيقاف بيعه مؤقتاً، أخفِه بدل حذفه. الطلبات القديمة لا تتأثر.`)) return;
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await staffApi(`/products/${productId}`, { method: "DELETE" });
        toast("تم حذف المنتج");
        load().catch((err) => showLoadError(content, errorText(err)));
      } catch (err) {
        toast(errorText(err), "error");
        button.disabled = false;
      }
    });
  });
}
