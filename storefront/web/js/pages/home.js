import { api, apiPage } from "../api.js";
import { mountLayout, esc, errorText, qs, icon, productCard, bindAddButtons, getCategories } from "../ui.js";

/**
 * الصفحة الرئيسية، وصفحة القسم، ونتائج البحث، كلها هنا.
 *
 * البحث والترتيب والترقيم تحدث في الخادم (GET /products?q=&sort=&limit=&offset=)، والعدد الكلي
 * يصل في ترويسة X-Total-Count، فتُبنى أزرار الصفحات دون تحميل كل المنتجات.
 * الرابط يحفظ الحالة (?q=&category=&sort=&page=)، فزر الرجوع والمشاركة يعملان.
 */
mountLayout("home");
const app = document.getElementById("app");

const PAGE_SIZE = 12;
const categoryId = qs("category");
const search = (qs("q") ?? "").trim();
const sort = ["newest", "price_asc", "price_desc", "name"].includes(qs("sort")) ? qs("sort") : "newest";
const page = Math.max(1, Number(qs("page")) || 1);

const SORTS = {
  newest: "الأحدث",
  price_asc: "السعر: من الأقل للأعلى",
  price_desc: "السعر: من الأعلى للأقل",
  name: "الاسم",
};

/** رابط الصفحة نفسها مع تغيير بعض المعاملات. */
function link(changes) {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const q = params.toString();
  return `index.html${q ? `?${q}` : ""}#products`;
}

async function load() {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), sort });
  if (categoryId) query.set("categoryId", categoryId);
  if (search) query.set("q", search);
  const [categories, { items: products, total }] = await Promise.all([getCategories(), apiPage(`/products?${query}`)]);

  // مستوى المخزون لكل منتج (ومعه أشكاله إن وُجدت) لشارات "نفد" و"اختر النوع".
  const stock = new Map(await Promise.all(products.map(async (p) => [p.id, await api(`/inventory/${p.id}`)])));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const current = categories.find((c) => c.id === categoryId);
  const title = search ? `نتائج البحث عن "${esc(search)}"` : current ? esc(current.name) : "كل المنتجات";
  const isHome = !search && !current && page === 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  app.innerHTML = `
    ${isHome ? hero() + trustBar() + (await categoryTiles(categories)) : `
    <nav class="breadcrumb"><a href="index.html">الرئيسية</a> / ${search ? "البحث" : current ? esc(current.name) : "كل المنتجات"}</nav>`}
    <section class="section" id="products">
      <div class="section-head">
        <div><h2>${title}</h2><span class="muted">${total} منتج</span></div>
        <label class="sort">ترتيب:
          <select data-sort>${Object.entries(SORTS).map(([k, label]) => `<option value="${k}" ${k === sort ? "selected" : ""}>${label}</option>`).join("")}</select>
        </label>
      </div>
      <div class="chips" role="navigation" aria-label="الأقسام">
        <a class="chip ${!categoryId ? "active" : ""}" href="${link({ category: null, page: null })}">الكل</a>
        ${categories.map((c) => `<a class="chip ${c.id === categoryId ? "active" : ""}" href="${link({ category: c.id, page: null })}">${esc(c.name)}</a>`).join("")}
      </div>
      ${products.length === 0
        ? `<div class="empty panel"><div class="big">لا توجد منتجات مطابقة</div><p>جرّب كلمة أخرى أو تصفّح الأقسام.</p><a class="btn btn-light" href="index.html">عرض كل المنتجات</a></div>`
        : `<div class="grid" data-grid>${products.map((p) => productCard(p, stock.get(p.id), categoryId ? null : categoryName.get(p.categoryId))).join("")}</div>`}
      ${pages > 1 ? pager(pages) : ""}
    </section>`;

  const grid = app.querySelector("[data-grid]");
  if (grid) bindAddButtons(grid);
  app.querySelector("[data-sort]")?.addEventListener("change", (e) => {
    location.href = link({ sort: e.target.value === "newest" ? null : e.target.value, page: null });
  });
}

/** أزرار الصفحات: السابق، والأرقام، والتالي. */
function pager(pages) {
  const items = [];
  for (let i = 1; i <= pages; i++) items.push(`<a class="${i === page ? "active" : ""}" href="${link({ page: i === 1 ? null : i })}">${i}</a>`);
  return `<nav class="pager" aria-label="الصفحات">
    ${page > 1 ? `<a href="${link({ page: page - 1 === 1 ? null : page - 1 })}">السابق</a>` : ""}
    ${items.join("")}
    ${page < pages ? `<a href="${link({ page: page + 1 })}">التالي</a>` : ""}
  </nav>`;
}

function hero() {
  return `
    <section class="hero">
      <div class="hero-text">
        <span class="eyebrow">${icon("pin", 16)} متجر ماء — تاجوراء، طرابلس</span>
        <h1>كل ما يحتاجه هاتفك <span class="accent">في مكان واحد</span></h1>
        <p>شواحن، كوابل، سماعات، ساعات ذكية وباور بانك بأسعار مناسبة. نوصّل لكل المدن الليبية، وتدفع عند الاستلام أو بالبطاقة.</p>
        <div class="hero-actions">
          <a class="btn btn-lg" href="#products">تسوّق الآن ${icon("arrow", 18)}</a>
          <a class="btn btn-ghost btn-lg" href="track.html">تتبّع طلبك</a>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <img class="hero-main" src="images/products/anc-headphones.webp" alt="">
        <img class="hero-side one" src="images/products/fitness-band.webp" alt="">
        <img class="hero-side two" src="images/products/silicone-case.webp" alt="">
        <div class="hero-chip">${icon("gift", 18)} كوبون WELCOME10 لأول طلب</div>
      </div>
    </section>`;
}

function trustBar() {
  const items = [
    ["truck", "توصيل لكل ليبيا", "من تاجوراء لكل المدن"],
    ["cash", "الدفع عند الاستلام", "أو بالبطاقة المصرفية"],
    ["store", "استلام من المحل", "مجاناً من فرعنا في تاجوراء"],
    ["gift", "توصيل مجاني", "للطلبات فوق 500 د.ل"],
  ];
  return `<section class="trust">${items.map(([i, t, s]) =>
    `<div class="trust-item"><span class="trust-icon">${icon(i, 24)}</span><div><b>${t}</b><span>${s}</span></div></div>`).join("")}</section>`;
}

/** بطاقات الأقسام: عدد منتجات كل قسم من X-Total-Count (طلب بحد 1 لكل قسم)، وصورة أول منتج. */
async function categoryTiles(categories) {
  const tiles = (
    await Promise.all(
      categories.map(async (c) => {
        const { items, total } = await apiPage(`/products?categoryId=${encodeURIComponent(c.id)}&limit=1`);
        return { c, count: total, image: items[0]?.imageUrl };
      })
    )
  ).filter((t) => t.count > 0);
  if (!tiles.length) return "";
  return `
    <section class="section">
      <div class="section-head"><div><h2>تسوّق حسب القسم</h2></div></div>
      <div class="cat-grid">${tiles.map(({ c, count, image }) => `
        <a class="cat-tile" href="${link({ category: c.id, page: null, q: null })}">
          <span class="cat-img">${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : ""}</span>
          <b>${esc(c.name)}</b><span class="muted">${count} منتج</span>
        </a>`).join("")}</div>
    </section>`;
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل المنتجات</div><p>${esc(errorText(err))}</p>
    <button class="btn" data-retry>إعادة المحاولة</button></div>`;
  app.querySelector("[data-retry]")?.addEventListener("click", () => location.reload());
});
