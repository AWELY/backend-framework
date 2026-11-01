// صفحة المنتج (product.html?id=<رقم المنتج>): الصورة، والسعر، والمخزون، واختيار الكمية،
// وزرّا "أضف إلى السلة" و"اشترِ الآن"، ومنتجات مشابهة من نفس القسم.
import { api, addToCart, ApiError } from "../api.js";
import { mountLayout, esc, stockBadge, priceHtml, errorText, toast, refreshCartBadge, qs, icon, productCard, bindAddButtons, getCategories } from "../ui.js";

mountLayout("product");
const app = document.getElementById("app");
const id = qs("id");

async function load() {
  // رابط بلا id: نعامله كمنتج غير موجود.
  if (!id) throw new ApiError(404, "Not found");
  // ثلاثة طلبات متوازية: المنتج، ومخزونه، والأقسام.
  const [product, stock, categories] = await Promise.all([
    api(`/products/${encodeURIComponent(id)}`),
    api(`/inventory/${encodeURIComponent(id)}`),
    getCategories(),
  ]);
  const category = categories.find((c) => c.id === product.categoryId);
  // عنوان تبويب المتصفح. document.title نص عادي، فلا يحتاج esc.
  document.title = `${product.name} | AMA`;

  // حتى 4 منتجات أخرى من نفس القسم: نطلب 5 (قد يكون المنتج الحالي بينها) ونحذفه منها.
  const related = category
    ? (await api(`/products?categoryId=${encodeURIComponent(category.id)}&limit=5`)).filter((p) => p.id !== product.id).slice(0, 4)
    : [];
  const relatedStock = new Map(
    await Promise.all(related.map(async (p) => [p.id, (await api(`/inventory/${p.id}`)).quantity]))
  );

  // أقصى كمية يمكن اختيارها: المخزون، ولا أكثر من 10 في المرة الواحدة.
  // الخادم يفحص المخزون مرة أخرى على أي حال، فهذا الحد لراحة المشتري فقط.
  const max = Math.min(stock.quantity, 10);
  app.innerHTML = `
    <nav class="breadcrumb"><a href="index.html">الرئيسية</a>
      ${category ? ` / <a href="index.html?category=${encodeURIComponent(category.id)}#products">${esc(category.name)}</a>` : ""}
      / <span>${esc(product.name)}</span></nav>
    <section class="product">
      <div class="gallery"><img src="${esc(product.imageUrl ?? "images/placeholder.svg")}" alt="${esc(product.name)}"></div>
      <div class="product-info">
        ${category ? `<a class="eyebrow-link" href="index.html?category=${encodeURIComponent(category.id)}#products">${esc(category.name)}</a>` : ""}
        <h1>${esc(product.name)}</h1>
        ${stockBadge(stock.quantity)}
        <div class="price-box">
          <div class="price">${priceHtml(product.price)}</div>
          <span class="muted">سعر التوصيل يُحسب حسب مدينتك عند إتمام الطلب</span>
        </div>
        ${product.description ? `<p class="desc">${esc(product.description)}</p>` : ""}
        ${stock.quantity > 0 ? `
        <div class="buy-row">
          <div class="qty">
            <button type="button" data-step="1" aria-label="زيادة">${icon("plus", 18)}</button>
            <input type="number" min="1" max="${max}" value="1" aria-label="الكمية" data-qty>
            <button type="button" data-step="-1" aria-label="إنقاص">${icon("minus", 18)}</button>
          </div>
          <button class="btn btn-lg" data-add>${icon("cartPlus", 20)} أضف إلى السلة</button>
          <button class="btn btn-dark btn-lg" data-buy-now>اشترِ الآن</button>
        </div>` : `<div class="alert error">نفدت الكمية حالياً. تابعنا، نعيد التوفير قريباً.</div>`}
        <ul class="perks">
          <li>${icon("truck", 22)}<div><b>توصيل لكل المدن الليبية</b><span>السعر حسب المدينة، ومجاني للطلبات فوق 500 د.ل</span></div></li>
          <li>${icon("cash", 22)}<div><b>الدفع نقداً عند الاستلام</b><span>لا تدفع شيئاً قبل أن يصلك طلبك</span></div></li>
          <li>${icon("store", 22)}<div><b>استلام مجاني من المحل</b><span>من فرعنا في تاجوراء</span></div></li>
        </ul>
      </div>
    </section>
    ${related.length ? `
    <section class="section">
      <div class="section-head"><div><h2>منتجات مشابهة</h2></div></div>
      <div class="grid" data-related>${related.map((p) => productCard(p, relatedStock.get(p.id) ?? 0)).join("")}</div>
    </section>` : ""}`;

  // زرّا + و -: data-step فيه 1 أو -1، والنتيجة تبقى بين 1 و max.
  const input = app.querySelector("[data-qty]");
  app.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      const next = Number(input.value) + Number(b.dataset.step);
      input.value = String(Math.min(max, Math.max(1, next)));
    })
  );
  // الكمية المختارة، مصححة: رقم صحيح بين 1 و max، حتى لو كتب الزائر قيمة غريبة يدوياً.
  const quantity = () => Math.min(max, Math.max(1, Math.floor(Number(input.value) || 1)));
  // نحفظ الزرين في متغيرين قبل أي await. (خطأ سابق في جدول 6.5: كان الكود يقرأ العنصر
  // المضغوط بعد استدعاء غير متزامن، فيجده قد صار null.)
  const addButton = app.querySelector("[data-add]");
  const buyNow = app.querySelector("[data-buy-now]");
  // "أضف إلى السلة": يبقى في الصفحة، ويحدّث رقم السلة في الرأس.
  addButton?.addEventListener("click", async () => {
    const n = quantity();
    addButton.disabled = true;
    try {
      await addToCart(product.id, n);
      toast(`تمت إضافة ${n} إلى السلة`);
      refreshCartBadge();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      addButton.disabled = false;
    }
  });
  // "اشترِ الآن": يضيف ثم ينتقل مباشرة إلى السلة.
  buyNow?.addEventListener("click", async () => {
    buyNow.disabled = true;
    try {
      await addToCart(product.id, quantity());
      location.href = "cart.html";
    } catch (err) {
      toast(errorText(err), "error");
      buyNow.disabled = false;
    }
  });
  const relatedGrid = app.querySelector("[data-related]");
  if (relatedGrid) bindAddButtons(relatedGrid);
}

// المنتج غير موجود (أو غير نشط، فالـ API يرد 404 للزبون): رسالة مختلفة عن فشل الاتصال.
load().catch((err) => {
  const notFound = err instanceof ApiError && err.status === 404;
  app.innerHTML = `<div class="empty"><div class="big">${notFound ? "المنتج غير موجود" : "تعذّر تحميل المنتج"}</div>
    <p>${notFound ? "ربما حُذف أو لم يعد متوفراً." : esc(errorText(err))}</p>
    <a class="btn" href="index.html">العودة للمتجر</a></div>`;
});
