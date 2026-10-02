import { api } from "../api.js";
import { mountLayout, esc, errorText, qs, icon, productCard, bindAddButtons, getCategories } from "../ui.js";

mountLayout("home");
const app = document.getElementById("app");

const categoryId = qs("category");
const search = (qs("q") ?? "").trim();

const SORTS = {
  default: { label: "الترتيب الافتراضي", compare: () => 0 },
  "price-asc": { label: "السعر: من الأقل للأعلى", compare: (a, b) => a.price - b.price },
  "price-desc": { label: "السعر: من الأعلى للأقل", compare: (a, b) => b.price - a.price },
};

async function load() {
  const [categories, products] = await Promise.all([
    getCategories(),
    api(`/products?limit=100${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ""}`),
  ]);

  // The API filters by category; the text search runs here, over names and descriptions.
  const term = search.toLowerCase();
  const shown = term
    ? products.filter((p) => `${p.name} ${p.description ?? ""}`.toLowerCase().includes(term))
    : products;

  // One stock lookup per product shown (a small catalogue - fine for this store).
  const stock = new Map(
    await Promise.all(shown.map(async (p) => [p.id, (await api(`/inventory/${p.id}`)).quantity]))
  );
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const current = categories.find((c) => c.id === categoryId);
  const title = search ? `نتائج البحث عن "${esc(search)}"` : current ? esc(current.name) : "كل المنتجات";
  const isHome = !search && !current;

  app.innerHTML = `
    ${isHome ? hero() + trustBar() + categoryTiles(categories, products) : `
    <nav class="breadcrumb"><a href="index.html">الرئيسية</a> / ${search ? "البحث" : esc(current.name)}</nav>`}
    <section class="section" id="products">
      <div class="section-head">
        <div><h2>${title}</h2><span class="muted">${shown.length} منتج</span></div>
        ${shown.length > 1 ? `
        <label class="sort">ترتيب:
          <select data-sort>${Object.entries(SORTS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("")}</select>
        </label>` : ""}
      </div>
      <div class="chips" role="navigation" aria-label="الأقسام">
        <a class="chip ${!categoryId ? "active" : ""}" href="index.html#products">الكل</a>
        ${categories
          .map((c) => `<a class="chip ${c.id === categoryId ? "active" : ""}" href="index.html?category=${encodeURIComponent(c.id)}#products">${esc(c.name)}</a>`)
          .join("")}
      </div>
      ${shown.length === 0
        ? `<div class="empty panel"><div class="big">لا توجد منتجات مطابقة</div><p>جرّب كلمة أخرى أو تصفّح الأقسام.</p><a class="btn btn-light" href="index.html">عرض كل المنتجات</a></div>`
        : `<div class="grid" data-grid></div>`}
    </section>`;

  const grid = app.querySelector("[data-grid]");
  const renderGrid = (sortKey) => {
    if (!grid) return;
    const sorted = [...shown].sort(SORTS[sortKey].compare);
    grid.innerHTML = sorted.map((p) => productCard(p, stock.get(p.id) ?? 0, categoryId ? null : categoryName.get(p.categoryId))).join("");
    bindAddButtons(grid);
  };
  renderGrid("default");
  app.querySelector("[data-sort]")?.addEventListener("change", (e) => renderGrid(e.target.value));
}

function hero() {
  return `
    <section class="hero">
      <div class="hero-text">
        <span class="eyebrow">${icon("pin", 16)} متجر AMA — تاجوراء، طرابلس</span>
        <h1>كل ما يحتاجه هاتفك <span class="accent">في مكان واحد</span></h1>
        <p>شواحن، كوابل، سماعات، ساعات ذكية وباور بانك بأسعار مناسبة. نوصّل لكل المدن الليبية، وتدفع عند الاستلام.</p>
        <div class="hero-actions">
          <a class="btn btn-lg" href="#products">تسوّق الآن ${icon("arrow", 18)}</a>
          <a class="btn btn-ghost btn-lg" href="track.html">تتبّع طلبك</a>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <img class="hero-main" src="images/products/anc-headphones.webp" alt="">
        <img class="hero-side one" src="images/products/fitness-band.webp" alt="">
        <img class="hero-side two" src="images/products/silicone-case.webp" alt="">
        <div class="hero-chip">${icon("gift", 18)} توصيل مجاني فوق 500 د.ل</div>
      </div>
    </section>`;
}

function trustBar() {
  const items = [
    ["truck", "توصيل لكل ليبيا", "من تاجوراء لكل المدن"],
    ["cash", "الدفع عند الاستلام", "ادفع نقداً للمندوب"],
    ["store", "استلام من المحل", "مجاناً من فرعنا في تاجوراء"],
    ["gift", "توصيل مجاني", "للطلبات فوق 500 د.ل"],
  ];
  return `<section class="trust">${items.map(([i, t, s]) =>
    `<div class="trust-item"><span class="trust-icon">${icon(i, 24)}</span><div><b>${t}</b><span>${s}</span></div></div>`).join("")}</section>`;
}

function categoryTiles(categories, products) {
  const tiles = categories
    .map((c) => {
      const items = products.filter((p) => p.categoryId === c.id);
      const image = items.find((p) => p.imageUrl)?.imageUrl;
      return { c, count: items.length, image };
    })
    .filter((t) => t.count > 0);
  if (!tiles.length) return "";
  return `
    <section class="section">
      <div class="section-head"><div><h2>تسوّق حسب القسم</h2></div></div>
      <div class="cat-grid">${tiles.map(({ c, count, image }) => `
        <a class="cat-tile" href="index.html?category=${encodeURIComponent(c.id)}#products">
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
