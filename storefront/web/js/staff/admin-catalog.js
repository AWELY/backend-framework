import { esc, money, errorText, toast } from "../ui.js";
import { ApiError } from "../api.js";
import { can, sapi, sapiPage, srequest, modal, pill, showMessage, toDirhams, toDinars } from "./common.js";

/**
 * الكتالوج في لوحة الإدارة: المنتجات وأشكالها ومخزونها، والأقسام.
 *
 * التعديل المتفائل (ETag و If-Match): عند فتح منتج للتعديل نحفظ نسخته من ترويسة ETag، ونرسلها
 * مع الحفظ. إن عدّل زميل نفس المنتج في الأثناء، يرد الخادم 412 بدل أن يكتب أحدنا فوق الآخر،
 * فنعرض رسالة ونعيد تحميل النسخة الجديدة.
 * الحقول الاختيارية الفارغة تُرسل null في PATCH، فتُمسح فعلاً (مثل إزالة المنتج من قسمه).
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function productsView(root) {
  const state = { q: "", page: 1 };
  const writable = can("products:write");
  root.innerHTML = `
    <h1>المنتجات</h1>
    <div class="toolbar">
      <input type="search" placeholder="بحث بالاسم" data-q>
      <span class="spacer"></span><span class="muted" data-count></span>
      ${writable ? `<button class="btn" data-new>منتج جديد</button>` : ""}
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th></th><th>المنتج</th><th>السعر</th><th>المخزون</th><th>الحالة</th></tr></thead><tbody data-rows></tbody></table></div>
    <div class="pager" data-pager></div>`;

  async function load() {
    const q = new URLSearchParams({ limit: "20", offset: String((state.page - 1) * 20), sort: "newest" });
    if (state.q) q.set("q", state.q);
    const { items, total } = await sapiPage(`/products?${q}`);
    const stock = await Promise.all(items.map((p) => sapi(`/inventory/${p.id}`)));
    root.querySelector("[data-count]").textContent = `${total} منتج`;
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((p, i) => {
          const s = stock[i];
          const qty = s.variants ? s.variants.reduce((n, v) => n + v.quantity, 0) : s.quantity;
          return `<tr class="clickable" data-open="${esc(p.id)}"><td><img class="thumb" src="${esc(p.imageUrl ?? "images/placeholder.svg")}" alt=""></td>
            <td><b>${esc(p.name)}</b><br><span class="muted ltr">${esc(p.slug)}</span>${s.variants ? ` ${pill(`${s.variants.length} أشكال`, "blue")}` : ""}</td>
            <td class="num">${money(p.price)}</td><td>${pill(String(qty), qty <= 0 ? "red" : qty <= 3 ? "amber" : "green")}</td>
            <td>${p.isActive ? pill("ظاهر", "green") : pill("مخفي")}</td></tr>`;
        }).join("")
      : `<tr><td colspan="5" class="empty-row">لا توجد منتجات</td></tr>`;
    root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => editProduct(r.dataset.open, load)));
    const pages = Math.ceil(total / 20);
    root.querySelector("[data-pager]").innerHTML = pages > 1
      ? `${state.page > 1 ? `<a href="#" data-go="${state.page - 1}">السابق</a>` : ""}<span>صفحة ${state.page} من ${pages}</span>${state.page < pages ? `<a href="#" data-go="${state.page + 1}">التالي</a>` : ""}`
      : "";
    root.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => ((e.preventDefault(), (state.page = Number(a.dataset.go))), load())));
  }
  let timer;
  root.querySelector("[data-q]").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => ((state.q = e.target.value.trim()), (state.page = 1), load()), 300);
  });
  root.querySelector("[data-new]")?.addEventListener("click", () => editProduct(null, load));
  await load();
}

/** نموذج المنتج (إنشاء أو تعديل)، مع الأشكال والمخزون عند التعديل. */
async function editProduct(id, onChange) {
  const categories = (await sapiPage("/categories?limit=100")).items;
  const { el, close } = modal(id ? "تعديل منتج" : "منتج جديد", `<div class="loading">جاري التحميل...</div>`);
  const body = el.querySelector(".modal-body");
  const writable = can("products:write");
  let etag = null;

  async function render() {
    let product = null;
    let stock = null;
    if (id) {
      const res = await srequest(`/products/${id}`);
      product = res.data;
      etag = res.headers.get("ETag");
      stock = await sapi(`/inventory/${id}`);
    }
    const variantStock = new Map((stock?.variants ?? []).map((v) => [v.variantId, v.quantity]));
    body.innerHTML = `
      <div data-msg></div>
      <form data-product novalidate>
        <div class="form-grid">
          <div class="field"><label>الاسم</label><input name="name" value="${esc(product?.name ?? "")}" required maxlength="200"></div>
          <div class="field"><label>الرابط (حروف إنجليزية صغيرة وشرطات)</label><input name="slug" class="ltr" value="${esc(product?.slug ?? "")}" required placeholder="usb-c-cable-2m"></div>
          <div class="field"><label>السعر (دينار)</label><input name="price" type="number" step="0.001" min="0" class="ltr" value="${product ? toDinars(product.price) : ""}" required></div>
          <div class="field"><label>القسم</label><select name="categoryId"><option value="">بلا قسم</option>${categories.map((c) => `<option value="${esc(c.id)}" ${c.id === product?.categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
          <div class="field wide"><label>رابط الصورة</label><input name="imageUrl" class="ltr" value="${esc(product?.imageUrl ?? "")}" placeholder="/images/products/x.webp"></div>
          <div class="field wide"><label>الوصف</label><textarea name="description" rows="3" maxlength="5000">${esc(product?.description ?? "")}</textarea></div>
          <label class="check-line wide"><input type="checkbox" name="isActive" ${product?.isActive === false ? "" : "checked"}> ظاهر في المتجر</label>
        </div>
        ${writable ? `<div class="actions-row"><button class="btn">${id ? "حفظ" : "إنشاء"}</button>${id ? `<button type="button" class="btn btn-light" data-delete>حذف المنتج</button>` : ""}
          ${etag ? `<span class="muted">النسخة ${esc(etag)}</span>` : ""}</div>` : ""}
      </form>
      ${id && can("inventory:write") && !product.variants.length ? `
      <div class="section-box"><h3>المخزون</h3>
        <div class="toolbar"><input type="number" min="0" max="1000000" value="${stock.quantity}" data-stock class="ltr"><button class="btn btn-light" data-save-stock>حفظ الكمية</button></div></div>` : ""}
      ${id ? `
      <div class="section-box"><h3>الأشكال (ألوان أو مقاسات)</h3>
        ${product.variants.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>الاسم</th><th>SKU</th><th>السعر</th><th>المخزون</th><th></th></tr></thead><tbody>
          ${product.variants.map((v) => `<tr><td>${esc(v.title)} ${v.isActive ? "" : pill("مخفي")}</td><td class="ltr">${esc(v.sku)}</td><td class="num">${v.price !== null ? money(v.price) : `<span class="muted">سعر المنتج</span>`}</td>
            <td>${can("inventory:write") ? `<input type="number" min="0" class="ltr" value="${variantStock.get(v.id) ?? 0}" data-vstock="${esc(v.id)}">` : (variantStock.get(v.id) ?? 0)}</td>
            <td>${writable ? `<button class="link-btn" data-vtoggle="${esc(v.id)}" data-active="${v.isActive}">${v.isActive ? "إخفاء" : "إظهار"}</button> <button class="link-btn" data-vdelete="${esc(v.id)}">حذف</button>` : ""}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">لا أشكال: المنتج يُباع كما هو.</p>`}
        ${writable ? `
        <form data-variant novalidate class="toolbar">
          <input name="title" placeholder="الاسم (مثل: أسود)" required maxlength="120">
          <input name="sku" class="ltr" placeholder="SKU (مثل: CASE-BLK)" required>
          <input name="price" type="number" step="0.001" min="0" class="ltr" placeholder="سعر خاص (اختياري)">
          <button class="btn btn-light">إضافة شكل</button>
        </form>` : ""}
      </div>` : ""}`;

    const run = async (fn, success) => {
      showMessage(el, null);
      try {
        await fn();
        toast(success);
        onChange();
        await render();
      } catch (err) {
        if (err instanceof ApiError && err.code === "PRECONDITION_FAILED") {
          showMessage(el, "عدّل شخص آخر هذا المنتج قبلك. أُعيد تحميل أحدث نسخة، راجعها ثم احفظ مجدداً.");
          await render();
          showMessage(el, "عدّل شخص آخر هذا المنتج قبلك. هذه أحدث نسخة، راجعها ثم احفظ مجدداً.");
          return;
        }
        showMessage(el, errorText(err));
      }
    };

    body.querySelector("[data-product]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      if (!SLUG.test(f.slug.value.trim())) return showMessage(el, "الرابط: حروف إنجليزية صغيرة وأرقام وشرطات فقط.");
      const data = {
        name: f.name.value.trim(),
        slug: f.slug.value.trim(),
        price: toDirhams(f.price.value),
        categoryId: f.categoryId.value || null,
        imageUrl: f.imageUrl.value.trim() || null,
        description: f.description.value.trim() || null,
        isActive: f.isActive.checked,
      };
      if (!id) {
        for (const k of ["categoryId", "imageUrl", "description"]) if (data[k] === null) delete data[k];
        try {
          const created = await sapi("/products", { method: "POST", body: data });
          id = created.id;
          toast("تم إنشاء المنتج. أضف المخزون أو الأشكال.");
          onChange();
          await render();
        } catch (err) {
          showMessage(el, errorText(err));
        }
        return;
      }
      run(() => sapi(`/products/${id}`, { method: "PATCH", body: data, ifMatch: etag }), "تم حفظ المنتج");
    });
    body.querySelector("[data-delete]")?.addEventListener("click", async () => {
      if (!confirm("حذف المنتج نهائياً؟ الطلبات القديمة تبقى كما هي.")) return;
      try {
        await sapi(`/products/${id}`, { method: "DELETE", ifMatch: etag });
        toast("تم حذف المنتج");
        onChange();
        close();
      } catch (err) {
        showMessage(el, errorText(err));
      }
    });
    body.querySelector("[data-save-stock]")?.addEventListener("click", () =>
      run(() => sapi(`/inventory/${id}`, { method: "PUT", body: { quantity: Number(body.querySelector("[data-stock]").value) } }), "تم حفظ المخزون")
    );
    body.querySelectorAll("[data-vstock]").forEach((input) =>
      input.addEventListener("change", () =>
        run(() => sapi(`/inventory/variants/${input.dataset.vstock}`, { method: "PUT", body: { quantity: Number(input.value) } }), "تم حفظ مخزون الشكل")
      )
    );
    body.querySelectorAll("[data-vtoggle]").forEach((b) =>
      b.addEventListener("click", () =>
        run(() => sapi(`/products/${id}/variants/${b.dataset.vtoggle}`, { method: "PATCH", body: { isActive: b.dataset.active !== "true" } }), "تم التحديث")
      )
    );
    body.querySelectorAll("[data-vdelete]").forEach((b) =>
      b.addEventListener("click", () => confirm("حذف هذا الشكل؟") && run(() => sapi(`/products/${id}/variants/${b.dataset.vdelete}`, { method: "DELETE" }), "تم حذف الشكل"))
    );
    body.querySelector("[data-variant]")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      run(
        () => sapi(`/products/${id}/variants`, {
          method: "POST",
          body: { title: f.title.value.trim(), sku: f.sku.value.trim().toUpperCase(), position: body.querySelectorAll("[data-vstock]").length, ...(f.price.value ? { price: toDirhams(f.price.value) } : {}) },
        }),
        "تمت إضافة الشكل. اضبط مخزونه."
      );
    });
  }

  try {
    await render();
  } catch (err) {
    body.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
  }
}

export async function categoriesView(root) {
  const writable = can("categories:write");
  root.innerHTML = `
    <h1>الأقسام</h1>
    <div class="toolbar"><span class="spacer"></span>${writable ? `<button class="btn" data-new>قسم جديد</button>` : ""}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الاسم</th><th>الرابط</th><th>الوصف</th></tr></thead><tbody data-rows></tbody></table></div>`;
  async function load() {
    const { items } = await sapiPage("/categories?limit=100");
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((c) => `<tr class="${writable ? "clickable" : ""}" data-open="${esc(c.id)}"><td><b>${esc(c.name)}</b></td><td class="ltr">${esc(c.slug)}</td><td class="muted">${esc(c.description ?? "—")}</td></tr>`).join("")
      : `<tr><td colspan="3" class="empty-row">لا توجد أقسام</td></tr>`;
    if (writable) root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => editCategory(items.find((c) => c.id === r.dataset.open), load)));
  }
  root.querySelector("[data-new]")?.addEventListener("click", () => editCategory(null, load));
  await load();
}

function editCategory(category, onChange) {
  const { el, close } = modal(category ? "تعديل قسم" : "قسم جديد", `
    <div data-msg></div>
    <form novalidate>
      <div class="field"><label>الاسم</label><input name="name" value="${esc(category?.name ?? "")}" required maxlength="120"></div>
      <div class="field"><label>الرابط</label><input name="slug" class="ltr" value="${esc(category?.slug ?? "")}" required></div>
      <div class="field"><label>الوصف (اتركه فارغاً لحذفه)</label><input name="description" value="${esc(category?.description ?? "")}" maxlength="2000"></div>
      <div class="actions-row"><button class="btn">حفظ</button>${category ? `<button type="button" class="btn btn-light" data-delete>حذف</button>` : ""}</div>
    </form>`);
  const form = el.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { name: form.name.value.trim(), slug: form.slug.value.trim(), description: form.description.value.trim() || null };
    if (!SLUG.test(data.slug)) return showMessage(el, "الرابط: حروف إنجليزية صغيرة وأرقام وشرطات فقط.");
    try {
      if (category) await sapi(`/categories/${category.id}`, { method: "PATCH", body: data, ifMatch: `"${category.version}"` });
      else {
        if (data.description === null) delete data.description;
        await sapi("/categories", { method: "POST", body: data });
      }
      toast("تم الحفظ");
      close();
      onChange();
    } catch (err) {
      showMessage(el, errorText(err));
    }
  });
  el.querySelector("[data-delete]")?.addEventListener("click", async () => {
    if (!confirm("حذف القسم؟ منتجاته تبقى بلا قسم.")) return;
    try {
      await sapi(`/categories/${category.id}`, { method: "DELETE" });
      toast("تم الحذف");
      close();
      onChange();
    } catch (err) {
      showMessage(el, errorText(err));
    }
  });
}
