// الصفحة الرئيسية (index.html): الواجهة، والأقسام، وشبكة المنتجات، والبحث، والترتيب، وخطوات الطلب.
// نفس الصفحة تعرض ثلاث حالات حسب الرابط:
//   index.html                  الرئيسية الكاملة (واجهة + أقسام + كل المنتجات + خطوات الطلب)
//   index.html?category=<id>    منتجات قسم واحد
//   index.html?q=<كلمة>         نتائج البحث
import { api } from "../api.js";
import { mountLayout, esc, errorText, qs, icon, productCard, bindAddButtons, getCategories, priceTag } from "../ui.js";

// الرأس والتذييل المشتركان، و "home" لتمييز رابط "كل المنتجات".
mountLayout("home");
// العنصر الذي تُرسم فيه الصفحة (<main id="app"> في index.html).
const app = document.getElementById("app");

const categoryId = qs("category");
const search = (qs("q") ?? "").trim();

// خيارات الترتيب. compare دالة مقارنة لـ sort: سالب يعني a أولاً، وموجب يعني b أولاً.
const SORTS = {
  default: { label: "الترتيب الافتراضي", compare: () => 0 },
  "price-asc": { label: "السعر: من الأقل للأعلى", compare: (a, b) => a.price - b.price },
  "price-desc": { label: "السعر: من الأعلى للأقل", compare: (a, b) => b.price - a.price },
};

async function load() {
  // ثلاثة طلبات في نفس الوقت (Promise.all) بدل واحد بعد الآخر: الأقسام، والمنتجات، وخيارات
  // الشراء (منها عدد مدن التوصيل في الواجهة). فشل الأخير لا يوقف الصفحة: catch ترجع null.
  const [categories, products, options] = await Promise.all([
    getCategories(),
    api(`/products?limit=100${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ""}`),
    api("/checkout/options").catch(() => null),
  ]);

  // الـ API يصفّي حسب القسم. أما البحث النصي فيحدث هنا في المتصفح، في الأسماء والأوصاف.
  const term = search.toLowerCase();
  const shown = term
    ? products.filter((p) => `${p.name} ${p.description ?? ""}`.toLowerCase().includes(term))
    : products;

  // طلب مخزون واحد لكل منتج معروض. مقبول لكتالوج صغير مثل هذا المتجر، والطلبات متوازية.
  // النتيجة Map: رقم المنتج وكميته.
  const stock = new Map(
    await Promise.all(shown.map(async (p) => [p.id, (await api(`/inventory/${p.id}`)).quantity]))
  );
  // رقم القسم واسمه، لعرض اسم القسم على كل بطاقة.
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const current = categories.find((c) => c.id === categoryId);
  // كلمة البحث كتبها الزائر في الرابط، فتمر عبر esc قبل وضعها في HTML (حماية من XSS).
  const title = search ? `نتائج البحث عن "${esc(search)}"` : current ? esc(current.name) : "كل المنتجات";
  const isHome = !search && !current;

  // الواجهة شريط بعرض الشاشة كلها، فتوضع قبل <main class="container"> لا داخله.
  if (isHome) app.insertAdjacentHTML("beforebegin", hero(products, stock, options));

  // الرئيسية تعرض الأقسام وخطوات الطلب، وصفحة القسم أو البحث تعرض مسار التنقل بدلها.
  app.innerHTML = `
    ${isHome ? categoryTiles(categories, products) : `
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
    </section>
    ${isHome ? howToOrder() : ""}`;

  // يرسم بطاقات المنتجات بالترتيب المختار، ثم يربط أزرار "أضف إلى السلة".
  // [...shown] نسخة، لأن sort تعدّل المصفوفة الأصلية. اسم القسم لا يُعرض داخل صفحة القسم نفسه.
  const grid = app.querySelector("[data-grid]");
  const renderGrid = (sortKey) => {
    if (!grid) return;
    const sorted = [...shown].sort(SORTS[sortKey].compare);
    grid.innerHTML = sorted.map((p) => productCard(p, stock.get(p.id) ?? 0, categoryId ? null : categoryName.get(p.categoryId))).join("");
    bindAddButtons(grid);
  };
  renderGrid("default");
  // تغيير الترتيب يعيد رسم الشبكة فقط، دون طلبات جديدة إلى الـ API.
  app.querySelector("[data-sort]")?.addEventListener("change", (e) => renderGrid(e.target.value));
}

/**
 * الواجهة أعلى الرئيسية: شريط كحلي بعرض الشاشة. يمين: العنوان والأزرار وحقائق المتجر.
 * يسار: "رف" فيه ثلاثة منتجات حقيقية من الكتالوج (لا صور ثابتة)، تحت كل منها ملصق سعرها.
 *
 * أي المنتجات؟ الأغلى المتوفر من كل قسم، لأول ثلاثة أقسام فيها منتج متوفر بصورة. هكذا يتغير
 * الرف وحده عندما يضيف المدير منتجات أو تنفد كمية، دون تعديل هذا الملف.
 * عدد مدن التوصيل يأتي من إضافة الشحن في الـ API (GET /checkout/options).
 */
function hero(products, stock, options) {
  const byCategory = new Map();
  for (const p of products) {
    if (!p.imageUrl || (stock.get(p.id) ?? 0) <= 0) continue;
    const best = byCategory.get(p.categoryId);
    if (!best || p.price > best.price) byCategory.set(p.categoryId, p);
  }
  const shelf = [...byCategory.values()].slice(0, 3);
  const cities = options?.shippingMethods.find((m) => m.cities)?.cities.length;
  return `
    <section class="hero-band"><div class="container">
      <div class="hero-text">
        <h1>إكسسوارات هاتفك، من محلنا في تاجوراء إلى باب بيتك</h1>
        <p>شواحن وسماعات وساعات ذكية وباور بانك. اطلب من الموقع، نتصل بك للتأكيد، ويصلك الطلب مع مندوبنا وتدفع نقداً عند الاستلام.</p>
        <div class="hero-actions">
          <a class="btn btn-lg" href="#products">تصفّح المنتجات</a>
          <a class="btn btn-ghost btn-lg" href="track.html">تتبّع طلبك</a>
        </div>
        <ul class="facts">
          <li>${icon("truck", 18)} توصيل إلى ${cities ? `<b>${cities}</b> مدينة` : "كل المدن"}</li>
          <li>${icon("cash", 18)} الدفع عند الاستلام</li>
          <li>${icon("store", 18)} استلام مجاني من المحل</li>
        </ul>
      </div>
      ${shelf.length === 3 ? `
      <div class="shelf">${shelf.map((p) => `
        <a class="shelf-item" href="product.html?id=${encodeURIComponent(p.id)}">
          <span class="ph"><img src="${esc(p.imageUrl)}" alt="${esc(p.name)}"></span>
          <span class="nm">${esc(p.name)}</span>
          ${priceTag(p.price)}
        </a>`).join("")}
      </div>` : ""}
    </div></section>`;
}

/**
 * خطوات الطلب: تسلسل حقيقي (ولهذا مرقّمة)، يشرح للمشتري الجديد كيف يعمل الدفع عند الاستلام.
 * الأرقام يرسمها CSS (counter في .how)، فتبقى صحيحة إن أُضيفت خطوة أو حُذفت.
 */
function howToOrder() {
  const steps = [
    ["اطلب من الموقع", "أضف المنتجات للسلة واختر مدينتك. لا تحتاج حساباً."],
    ["نتصل بك للتأكيد", "نراجع الطلب ونتصل على رقمك خلال ساعات العمل."],
    ["يصلك مع المندوب", "تتابع كل مرحلة من صفحة تتبّع الطلب."],
    ["ادفع عند الاستلام", "نقداً للمندوب بعد أن ترى طلبك، أو في المحل."],
  ];
  return `
    <section class="how" aria-labelledby="how-title">
      <h2 id="how-title">كيف تطلب من AMA</h2>
      <ol>${steps.map(([t, d]) => `<li><div><b>${t}</b><span>${d}</span></div></li>`).join("")}</ol>
    </section>`;
}

/**
 * مربعات الأقسام: لكل قسم صورة أول منتج فيه وعدد منتجاته. القسم الفارغ لا يظهر.
 * "?." تعطي undefined بدل الخطأ إن لم يوجد منتج بصورة.
 */
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
          <span><b>${esc(c.name)}</b><br><span class="muted">${count} منتج</span></span>
        </a>`).join("")}</div>
    </section>`;
}

// إن فشل التحميل (مثلاً الـ API متوقف): رسالة واضحة وزر لإعادة المحاولة، بدل صفحة فارغة.
load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل المنتجات</div><p>${esc(errorText(err))}</p>
    <button class="btn" data-retry>إعادة المحاولة</button></div>`;
  app.querySelector("[data-retry]")?.addEventListener("click", () => location.reload());
});
