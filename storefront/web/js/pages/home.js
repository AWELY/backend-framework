import { api, addToCart } from "../api.js";
import { mountLayout, esc, money, stockBadge, errorText, toast, refreshCartBadge, qs } from "../ui.js";

mountLayout("home");
const app = document.getElementById("app");

const categoryId = qs("category");
const search = (qs("q") ?? "").trim();

async function load() {
  const [categories, products] = await Promise.all([
    api("/categories"),
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

  const current = categories.find((c) => c.id === categoryId);
  const title = search ? `نتائج البحث عن "${esc(search)}"` : current ? esc(current.name) : "كل المنتجات";

  app.innerHTML = `
    ${search || current ? "" : `
    <section class="hero">
      <div>
        <h1>أحدث إكسسوارات الهواتف والإلكترونيات</h1>
        <p>شواحن، سماعات، ساعات ذكية وأكثر — توصيل سريع لكل المدن الليبية وادفع عند الاستلام.</p>
        <a class="btn" href="#products">تسوّق الآن</a>
      </div>
      <div class="hero-art"><img src="images/products/headphones.svg" alt=""></div>
    </section>
    <section class="features">
      <div class="feature"><div class="icon">🚚</div><div><b>توصيل لكل ليبيا</b><span>من تاجوراء لكل المدن</span></div></div>
      <div class="feature"><div class="icon">💵</div><div><b>الدفع عند الاستلام</b><span>ادفع نقداً للمندوب</span></div></div>
      <div class="feature"><div class="icon">🏪</div><div><b>استلام من المحل</b><span>مجاناً من فرعنا في تاجوراء</span></div></div>
      <div class="feature"><div class="icon">🎁</div><div><b>توصيل مجاني</b><span>للطلبات فوق 500 د.ل</span></div></div>
    </section>`}
    <section class="section" id="products">
      <div class="chips" role="navigation" aria-label="الأقسام">
        <a class="chip ${!categoryId ? "active" : ""}" href="index.html#products">الكل</a>
        ${categories
          .map((c) => `<a class="chip ${c.id === categoryId ? "active" : ""}" href="index.html?category=${encodeURIComponent(c.id)}#products">${esc(c.name)}</a>`)
          .join("")}
      </div>
      <div class="section-head spaced">
        <h2>${title}</h2><span class="muted">${shown.length} منتج</span>
      </div>
      ${shown.length === 0
        ? `<div class="empty"><div class="big">لا توجد منتجات مطابقة</div><a class="btn btn-light" href="index.html">عرض كل المنتجات</a></div>`
        : `<div class="grid">${shown.map((p) => card(p, stock.get(p.id) ?? 0)).join("")}</div>`}
    </section>`;

  app.querySelectorAll("[data-add]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await addToCart(btn.dataset.add, 1);
        toast("تمت الإضافة إلى السلة ✓");
        refreshCartBadge();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        btn.disabled = false;
      }
    })
  );
}

function card(p, quantity) {
  const url = `product.html?id=${encodeURIComponent(p.id)}`;
  return `
    <article class="card">
      <a class="thumb" href="${url}">
        <img src="${esc(p.imageUrl ?? "images/products/charger.svg")}" alt="${esc(p.name)}" loading="lazy">
        ${stockBadge(quantity)}
      </a>
      <div class="body">
        <a class="name" href="${url}">${esc(p.name)}</a>
        <div class="price">${money(p.price)}</div>
        <div class="actions">
          <button class="btn btn-block btn-sm" data-add="${esc(p.id)}" ${quantity <= 0 ? "disabled" : ""}>
            ${quantity <= 0 ? "نفدت الكمية" : "أضف إلى السلة"}
          </button>
        </div>
      </div>
    </article>`;
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل المنتجات</div><p>${esc(errorText(err))}</p>
    <button class="btn" data-retry>إعادة المحاولة</button></div>`;
  app.querySelector("[data-retry]")?.addEventListener("click", () => location.reload());
});
