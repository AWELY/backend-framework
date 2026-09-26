import { api, addToCart, ApiError } from "../api.js";
import { mountLayout, esc, money, stockBadge, errorText, toast, refreshCartBadge, qs } from "../ui.js";

mountLayout("product");
const app = document.getElementById("app");
const id = qs("id");

async function load() {
  if (!id) throw new ApiError(404, "Not found");
  const [product, stock, categories] = await Promise.all([
    api(`/products/${encodeURIComponent(id)}`),
    api(`/inventory/${encodeURIComponent(id)}`),
    api("/categories"),
  ]);
  const category = categories.find((c) => c.id === product.categoryId);
  document.title = `${product.name} | AMA`;

  // Up to 4 other products from the same category.
  const related = category
    ? (await api(`/products?categoryId=${encodeURIComponent(category.id)}&limit=5`)).filter((p) => p.id !== product.id).slice(0, 4)
    : [];

  const max = Math.min(stock.quantity, 10);
  app.innerHTML = `
    <nav class="breadcrumb"><a href="index.html">الرئيسية</a>
      ${category ? ` / <a href="index.html?category=${encodeURIComponent(category.id)}">${esc(category.name)}</a>` : ""}
      / ${esc(product.name)}</nav>
    <section class="product">
      <div class="gallery"><img src="${esc(product.imageUrl ?? "images/products/charger.svg")}" alt="${esc(product.name)}"></div>
      <div>
        <h1>${esc(product.name)}</h1>
        ${stockBadge(stock.quantity)}
        <div class="price">${money(product.price)}</div>
        ${product.description ? `<p class="desc">${esc(product.description)}</p>` : ""}
        ${stock.quantity > 0 ? `
        <div class="buy-row">
          <div class="qty">
            <button type="button" data-step="1" aria-label="زيادة">+</button>
            <input type="number" min="1" max="${max}" value="1" aria-label="الكمية" data-qty>
            <button type="button" data-step="-1" aria-label="إنقاص">−</button>
          </div>
          <button class="btn" data-add>أضف إلى السلة</button>
          <a class="btn btn-dark" href="cart.html">اذهب إلى السلة</a>
        </div>` : `<div class="alert error">نفدت الكمية حالياً. تابعنا، نعيد التوفير قريباً.</div>`}
        <ul class="info-list">
          <li>🚚 توصيل لكل المدن الليبية — السعر حسب المدينة عند إتمام الطلب</li>
          <li>💵 الدفع نقداً عند الاستلام</li>
          <li>🏪 أو استلمه مجاناً من المحل في تاجوراء</li>
        </ul>
      </div>
    </section>
    ${related.length ? `
    <section class="section">
      <div class="section-head"><h2>منتجات مشابهة</h2></div>
      <div class="grid">${related.map((p) => `
        <a class="card" href="product.html?id=${encodeURIComponent(p.id)}">
          <div class="thumb"><img src="${esc(p.imageUrl ?? "images/products/charger.svg")}" alt="${esc(p.name)}" loading="lazy"></div>
          <div class="body"><span class="name">${esc(p.name)}</span><span class="price">${money(p.price)}</span></div>
        </a>`).join("")}</div>
    </section>` : ""}`;

  const input = app.querySelector("[data-qty]");
  app.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      const next = Number(input.value) + Number(b.dataset.step);
      input.value = String(Math.min(max, Math.max(1, next)));
    })
  );
  const addButton = app.querySelector("[data-add]");
  addButton?.addEventListener("click", async () => {
    const quantity = Math.min(max, Math.max(1, Math.floor(Number(input.value) || 1)));
    addButton.disabled = true;
    try {
      await addToCart(product.id, quantity);
      toast(`تمت إضافة ${quantity} إلى السلة ✓`);
      refreshCartBadge();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      addButton.disabled = false;
    }
  });
}

load().catch((err) => {
  const notFound = err instanceof ApiError && err.status === 404;
  app.innerHTML = `<div class="empty"><div class="big">${notFound ? "المنتج غير موجود" : "تعذّر تحميل المنتج"}</div>
    <p>${notFound ? "ربما حُذف أو لم يعد متوفراً." : esc(errorText(err))}</p>
    <a class="btn" href="index.html">العودة للمتجر</a></div>`;
});
