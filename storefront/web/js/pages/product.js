import { api, apiPage, addToCart, ApiError } from "../api.js";
import { mountLayout, esc, money, stockBadge, priceHtml, errorText, toast, refreshCartBadge, qs, icon, productCard, bindAddButtons, getCategories } from "../ui.js";

/**
 * صفحة منتج واحد: الصورة، والسعر، والمخزون، والأشكال (ألوان أو مقاسات)، والإضافة إلى السلة.
 *
 * المنتج ذو الأشكال: كل شكل زر بسعره ومخزونه. السعر والمخزون والحد الأقصى للكمية تتبع الشكل
 * المختار، والإضافة ترسل variantId. الخادم يرفض إضافة منتج له أشكال دون شكل (VARIANT_REQUIRED).
 * الرابط ?id= أو ?slug= (رابط مقروء: product.html?slug=anc-headphones).
 */
mountLayout("product");
const app = document.getElementById("app");
const id = qs("id");
const slug = qs("slug");

async function load() {
  if (!id && !slug) throw new ApiError(404, "Not found", null, "NOT_FOUND");
  const product = await api(id ? `/products/${encodeURIComponent(id)}` : `/products/by-slug/${encodeURIComponent(slug)}`);
  const [stock, categories] = await Promise.all([api(`/inventory/${product.id}`), getCategories()]);
  const category = categories.find((c) => c.id === product.categoryId);
  document.title = `${product.name} | متجر ماء`;

  const variants = product.variants ?? [];
  const variantStock = new Map((stock.variants ?? []).map((v) => [v.variantId, v.quantity]));
  const firstAvailable = variants.find((v) => (variantStock.get(v.id) ?? 0) > 0);
  let selected = firstAvailable ?? null;

  const related = category
    ? (await apiPage(`/products?categoryId=${encodeURIComponent(category.id)}&limit=5`)).items.filter((p) => p.id !== product.id).slice(0, 4)
    : [];
  const relatedStock = new Map(await Promise.all(related.map(async (p) => [p.id, await api(`/inventory/${p.id}`)])));

  const priceOf = (v) => (v && v.price !== null ? v.price : product.price);
  const quantityOf = (v) => (variants.length ? (v ? (variantStock.get(v.id) ?? 0) : 0) : stock.quantity);

  app.innerHTML = `
    <nav class="breadcrumb"><a href="index.html">الرئيسية</a>
      ${category ? ` / <a href="index.html?category=${encodeURIComponent(category.id)}#products">${esc(category.name)}</a>` : ""}
      / <span>${esc(product.name)}</span></nav>
    <section class="product">
      <div class="gallery"><img src="${esc(product.imageUrl ?? "images/placeholder.svg")}" alt="${esc(product.name)}"></div>
      <div class="product-info">
        ${category ? `<a class="eyebrow-link" href="index.html?category=${encodeURIComponent(category.id)}#products">${esc(category.name)}</a>` : ""}
        <h1>${esc(product.name)}</h1>
        <div data-stock></div>
        <div class="price-box">
          <div class="price" data-price></div>
          <span class="muted">سعر التوصيل يُحسب حسب مدينتك عند إتمام الطلب</span>
        </div>
        ${product.description ? `<p class="desc">${esc(product.description)}</p>` : ""}
        ${variants.length ? `
        <div class="variants" role="radiogroup" aria-label="النوع">
          <b>اختر النوع:</b>
          <div class="variant-list">${variants.map((v) => {
            const qty = variantStock.get(v.id) ?? 0;
            return `<button type="button" class="variant-chip ${qty <= 0 ? "out" : ""}" data-variant="${esc(v.id)}" role="radio" ${qty <= 0 ? "disabled" : ""}>
              ${esc(v.title)}${v.price !== null ? ` <span class="muted">(${money(v.price)})</span>` : ""}${qty <= 0 ? " — نفد" : ""}</button>`;
          }).join("")}</div>
        </div>` : ""}
        <div data-buy></div>
        <ul class="perks">
          <li>${icon("truck", 22)}<div><b>توصيل لكل المدن الليبية</b><span>السعر حسب المدينة، ومجاني للطلبات فوق 500 د.ل</span></div></li>
          <li>${icon("cash", 22)}<div><b>الدفع عند الاستلام أو بالبطاقة</b><span>لا تدفع شيئاً قبل أن يصلك طلبك</span></div></li>
          <li>${icon("store", 22)}<div><b>استلام مجاني من المحل</b><span>من فرعنا في تاجوراء</span></div></li>
        </ul>
      </div>
    </section>
    ${related.length ? `
    <section class="section">
      <div class="section-head"><div><h2>منتجات مشابهة</h2></div></div>
      <div class="grid" data-related>${related.map((p) => productCard(p, relatedStock.get(p.id))).join("")}</div>
    </section>` : ""}`;

  /** يعيد رسم السعر والمخزون وأزرار الشراء حسب الشكل المختار. */
  function renderBuy() {
    const qty = quantityOf(selected);
    const max = Math.min(qty, 10);
    app.querySelector("[data-price]").innerHTML = priceHtml(priceOf(selected));
    app.querySelector("[data-stock]").innerHTML = variants.length && !selected ? "" : stockBadge(qty);
    app.querySelectorAll("[data-variant]").forEach((b) => {
      const active = b.dataset.variant === selected?.id;
      b.classList.toggle("active", active);
      b.setAttribute("aria-checked", String(active));
    });
    const buy = app.querySelector("[data-buy]");
    if (variants.length && !selected) {
      buy.innerHTML = `<div class="alert error">نفدت كل الأنواع حالياً.</div>`;
      return;
    }
    if (qty <= 0) {
      buy.innerHTML = `<div class="alert error">نفدت الكمية حالياً. تابعنا، نعيد التوفير قريباً.</div>`;
      return;
    }
    buy.innerHTML = `
      <div class="buy-row">
        <div class="qty">
          <button type="button" data-step="1" aria-label="زيادة">${icon("plus", 18)}</button>
          <input type="number" min="1" max="${max}" value="1" aria-label="الكمية" data-qty>
          <button type="button" data-step="-1" aria-label="إنقاص">${icon("minus", 18)}</button>
        </div>
        <button class="btn btn-lg" data-add>${icon("cartPlus", 20)} أضف إلى السلة</button>
        <button class="btn btn-dark btn-lg" data-buy-now>اشترِ الآن</button>
      </div>`;
    const input = buy.querySelector("[data-qty]");
    buy.querySelectorAll("[data-step]").forEach((b) =>
      b.addEventListener("click", () => {
        input.value = String(Math.min(max, Math.max(1, Number(input.value) + Number(b.dataset.step))));
      })
    );
    const quantity = () => Math.min(max, Math.max(1, Math.floor(Number(input.value) || 1)));
    const add = async (button, then) => {
      button.disabled = true;
      try {
        await addToCart(product.id, quantity(), selected?.id);
        refreshCartBadge();
        then();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        button.disabled = false;
      }
    };
    const addButton = buy.querySelector("[data-add]");
    addButton.addEventListener("click", () => add(addButton, () => toast(`تمت إضافة ${quantity()} إلى السلة`)));
    const buyNow = buy.querySelector("[data-buy-now]");
    buyNow.addEventListener("click", () => add(buyNow, () => (location.href = "cart.html")));
  }

  app.querySelectorAll("[data-variant]").forEach((b) =>
    b.addEventListener("click", () => {
      selected = variants.find((v) => v.id === b.dataset.variant) ?? null;
      renderBuy();
    })
  );
  renderBuy();
  const relatedGrid = app.querySelector("[data-related]");
  if (relatedGrid) bindAddButtons(relatedGrid);
}

load().catch((err) => {
  const notFound = err instanceof ApiError && err.status === 404;
  app.innerHTML = `<div class="empty"><div class="big">${notFound ? "المنتج غير موجود" : "تعذّر تحميل المنتج"}</div>
    <p>${notFound ? "ربما حُذف أو لم يعد متوفراً." : esc(errorText(err))}</p>
    <a class="btn" href="index.html">العودة للمتجر</a></div>`;
});
