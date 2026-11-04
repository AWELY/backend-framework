// إضافة منتج أو تعديله (admin/product.html، أو product.html?id=... للتعديل).
//
// مسارات الإطار: POST /products للإضافة، و PATCH /products/:id للتعديل، و PUT /inventory/:id
// للكمية. الإطار يتحقق من كل حقل (productInputSchema)، وأي خطأ يعود 400 بقائمة الحقول،
// فنعرض رسالة كل حقل تحته.
//
// الصورة: الإطار يحفظ رابط الصورة فقط (لا يرفع ملفات). نعرض صور المنتجات الموجودة للاختيار
// السريع، أو يُكتب رابط كامل (https://...) لصورة على الإنترنت.
import { requireAdmin, mountAdmin, staffApi, esc, errorText, toast, qs, showLoadError, toDirhams, toLyd, PLACEHOLDER } from "../common.js";

const id = qs("id");
const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, {
    active: "products",
    title: id ? "تعديل منتج" : "إضافة منتج",
    actions: `<a class="btn btn-sm btn-light" href="products.html">كل المنتجات</a>`,
  });
  load().catch((err) => showLoadError(content, err.status === 404 ? "المنتج غير موجود." : errorText(err)));
}

// نفس قاعدة الـ slug في الإطار (SLUG_PATTERN): حروف إنجليزية صغيرة وأرقام وشرطات مفردة.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function load() {
  const [product, categories, products, stock] = await Promise.all([
    id ? staffApi(`/products/${encodeURIComponent(id)}`) : null,
    staffApi("/categories?limit=100"),
    staffApi("/products?limit=100"),
    id ? staffApi(`/inventory/${encodeURIComponent(id)}`) : null,
  ]);
  // صور المنتجات الموجودة (بلا تكرار) للاختيار السريع.
  const images = [...new Set(products.map((p) => p.imageUrl).filter(Boolean))];
  const p = product ?? { name: "", slug: "", description: "", price: 0, categoryId: null, isActive: true, imageUrl: "" };

  content.innerHTML = `
    <form class="cols detail" novalidate data-form>
      <section class="box">
        <div class="box-head"><h2>بيانات المنتج</h2></div>
        <div class="box-body">
          <div data-error></div>
          <div class="form-grid">
            <div class="field full"><label for="name">اسم المنتج</label><input id="name" name="name" maxlength="200" value="${esc(p.name)}" required><div class="error"></div></div>
            <div class="field"><label for="slug">الاسم في الرابط</label><input id="slug" name="slug" class="ltr" maxlength="200" value="${esc(p.slug)}" placeholder="fast-charger-20w" required>
              <span class="hint">حروف إنجليزية صغيرة وأرقام وشرطات. لا يتكرر بين منتجين.</span><div class="error"></div></div>
            <div class="field"><label for="price">السعر بالدينار</label><input id="price" name="price" type="number" min="0" step="0.001" class="ltr" value="${product ? esc(toLyd(p.price)) : ""}" placeholder="35" required>
              <span class="hint">يُحفظ بالدرهم، والدينار ألف درهم.</span><div class="error"></div></div>
            <div class="field"><label for="category">القسم</label>
              <select id="category" name="categoryId"><option value="">بلا قسم</option>
                ${categories.map((c) => `<option value="${esc(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
              </select><div class="error"></div></div>
            <div class="field"><label for="quantity">الكمية في المخزون</label><input id="quantity" name="quantity" type="number" min="0" step="1" class="ltr" value="${stock?.quantity ?? 0}"><div class="error"></div></div>
            <div class="field full"><label for="description">الوصف</label><textarea id="description" name="description" rows="5" maxlength="5000">${esc(p.description ?? "")}</textarea><div class="error"></div></div>
          </div>
          <label class="check-row"><input type="checkbox" class="switch" name="isActive" ${p.isActive ? "checked" : ""}> ظاهر للزبائن في المتجر</label>
          <div class="action-row">
            <button class="btn btn-lg" type="submit">${id ? "حفظ التغييرات" : "إضافة المنتج"}</button>
            ${id ? `<a class="btn btn-lg btn-light" href="../product.html?id=${encodeURIComponent(id)}" target="_blank" rel="noopener">عرضه في المتجر</a>` : ""}
          </div>
        </div>
      </section>

      <section class="box">
        <div class="box-head"><h2>الصورة</h2></div>
        <div class="box-body">
          <img class="img-preview" src="${esc(previewSrc(p.imageUrl))}" alt="" data-preview>
          <div class="field"><label for="imageUrl">رابط الصورة</label><input id="imageUrl" name="imageUrl" class="ltr" maxlength="2000" value="${esc(p.imageUrl ?? "")}" placeholder="/images/products/name.webp">
            <span class="hint">مسار على موقع المتجر يبدأ بـ <span class="ltr">/</span> أو رابط كامل يبدأ بـ <span class="ltr">https://</span></span><div class="error"></div></div>
          ${images.length ? `<span class="muted">أو اختر من الصور الموجودة:</span>
          <div class="img-picks">${images.map((src) => `<button type="button" data-pick="${esc(src)}" class="${src === p.imageUrl ? "on" : ""}" aria-label="اختيار هذه الصورة"><img src="${esc(previewSrc(src))}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
        </div>
      </section>
    </form>`;

  bindForm(content.querySelector("[data-form]"));
}

/**
 * مصدر صورة المعاينة. المسار "/images/..." يبدأ من جذر موقع المتجر، وهو يعمل كما هو داخل
 * مجلد admin أيضاً (نفس الخادم). الحقل الفارغ يعرض الصورة البديلة.
 */
const previewSrc = (url) => (url ? url : PLACEHOLDER);

function bindForm(form) {
  const preview = form.querySelector("[data-preview]");
  const setImage = (url) => {
    form.imageUrl.value = url;
    preview.src = previewSrc(url);
    form.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("on", b.dataset.pick === url));
  };
  form.imageUrl.addEventListener("change", () => setImage(form.imageUrl.value.trim()));
  form.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => setImage(b.dataset.pick)));

  /** رسالة تحت حقل باسمه، أو مسحها. */
  const fieldError = (name, message) => {
    const input = form.elements.namedItem(name);
    const field = input?.closest?.(".field");
    if (!field) return;
    field.classList.toggle("invalid", Boolean(message));
    field.querySelector(".error").textContent = message ?? "";
  };
  form.addEventListener("input", (e) => fieldError(e.target.name, null));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector("[data-error]").innerHTML = "";
    // نفس قواعد الإطار، لرسائل فورية. الخادم يفحص مرة أخرى على أي حال.
    const name = form.name.value.trim();
    const slug = form.slug.value.trim();
    const price = Number(form.price.value);
    const quantity = Number(form.quantity.value || 0);
    const imageUrl = form.imageUrl.value.trim();
    const errors = {
      name: name ? null : "الاسم مطلوب",
      slug: SLUG.test(slug) ? null : "حروف إنجليزية صغيرة وأرقام وشرطات فقط، مثل usb-cable-2m",
      price: form.price.value !== "" && price >= 0 ? null : "أدخل السعر بالدينار",
      quantity: Number.isInteger(quantity) && quantity >= 0 ? null : "رقم صحيح من 0 فأكثر",
      imageUrl: !imageUrl || /^(https?:\/\/|\/)\S+$/.test(imageUrl) ? null : "الرابط يبدأ بشرطة مائلة أو بـ https",
    };
    for (const [field, message] of Object.entries(errors)) fieldError(field, message);
    if (Object.values(errors).some(Boolean)) return;

    // الجسم كما يتوقعه الإطار. الحقول الاختيارية الفارغة لا تُرسل عند الإضافة (الإطار يرفض النص
    // الفارغ لـ categoryId و imageUrl). عند التعديل لا يمكن "إفراغ" حقل بإرساله فارغاً، فالإطار
    // لا يقبل null في PATCH؛ تبقى القيمة القديمة.
    const body = { name, slug, price: toDirhams(price), isActive: form.isActive.checked, description: form.description.value.trim() };
    if (form.categoryId.value) body.categoryId = form.categoryId.value;
    if (imageUrl) body.imageUrl = imageUrl;

    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const saved = id
        ? await staffApi(`/products/${encodeURIComponent(id)}`, { method: "PATCH", body })
        : await staffApi("/products", { method: "POST", body });
      // الكمية في وحدة المخزون (مسار منفصل في الإطار): المنتجات لا تعرف شيئاً عن المخزون.
      await staffApi(`/inventory/${saved.id}`, { method: "PUT", body: { quantity } });
      toast(id ? "تم حفظ التغييرات" : "تمت إضافة المنتج");
      if (!id) location.replace(`product.html?id=${encodeURIComponent(saved.id)}`);
      else button.disabled = false;
    } catch (err) {
      button.disabled = false;
      // 400 من مدقّق الإطار: رسالة كل حقل تحته. 409: الـ slug مستخدم من منتج آخر.
      if (Array.isArray(err.details)) for (const d of err.details) fieldError(d.field, errorText({ status: 400, details: [d] }));
      const message = err.status === 409 ? "هذا الاسم في الرابط مستخدم لمنتج آخر. اختر اسماً مختلفاً." : errorText(err);
      if (err.status === 409) fieldError("slug", "مستخدم لمنتج آخر");
      form.querySelector("[data-error]").innerHTML = `<div class="alert error">${esc(message)}</div>`;
    }
  });
}
