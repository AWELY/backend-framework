// صفحة الأقسام في لوحة التحكم (admin/categories.html): إضافة وتعديل وحذف.
// مسارات الإطار كلها: GET/POST /categories و PATCH/DELETE /categories/:id (صلاحية categories:write).
import { requireAdmin, mountAdmin, staffApi, esc, icon, errorText, toast, showLoadError, openDialog, userError } from "../common.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, {
    active: "categories",
    title: "الأقسام",
    actions: `<button class="btn btn-sm" data-new>${icon("plus", 18)} إضافة قسم</button>`,
  });
  document.querySelector("[data-new]").addEventListener("click", () => editDialog(null));
  load().catch((err) => showLoadError(content, errorText(err)));
}

async function load() {
  const [categories, products] = await Promise.all([staffApi("/categories?limit=100"), staffApi("/products?limit=100")]);
  // عدد منتجات كل قسم (ومنها المخفية)، ليعرف المدير أثر الحذف قبل أن يحذف.
  const count = (id) => products.filter((p) => p.categoryId === id).length;

  content.innerHTML = `
    <section class="box">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>القسم</th><th>الاسم في الرابط</th><th>الوصف</th><th>المنتجات</th><th></th></tr></thead>
        <tbody>${categories.length ? categories.map((c) => `
          <tr data-id="${esc(c.id)}">
            <td><a class="row-link" href="../index.html?category=${encodeURIComponent(c.id)}" target="_blank" rel="noopener">${esc(c.name)}</a></td>
            <td class="ltr">${esc(c.slug)}</td>
            <td class="muted">${esc(c.description ?? "")}</td>
            <td class="n">${count(c.id)}</td>
            <td><div class="action-row">
              <button class="btn btn-sm btn-light" data-edit aria-label="تعديل">${icon("edit", 16)}</button>
              <button class="btn btn-sm btn-danger" data-delete aria-label="حذف">${icon("trash", 16)}</button>
            </div></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty-row">لا أقسام بعد. أضف أول قسم.</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  content.querySelectorAll("tr[data-id]").forEach((tr) => {
    const category = categories.find((c) => c.id === tr.dataset.id);
    tr.querySelector("[data-edit]").addEventListener("click", () => editDialog(category));
    tr.querySelector("[data-delete]").addEventListener("click", async (e) => {
      const n = count(category.id);
      // حذف القسم لا يحذف منتجاته: الإطار يجعل category_id فيها NULL (ON DELETE SET NULL).
      if (!confirm(`حذف قسم "${category.name}"؟${n ? `\nمنتجاته (${n}) تبقى في المتجر بلا قسم.` : ""}`)) return;
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await staffApi(`/categories/${category.id}`, { method: "DELETE" });
        toast("تم حذف القسم");
        load().catch((err) => showLoadError(content, errorText(err)));
      } catch (err) {
        toast(errorText(err), "error");
        button.disabled = false;
      }
    });
  });
}

/** نافذة إضافة قسم (category = null) أو تعديله. */
function editDialog(category) {
  openDialog({
    title: category ? "تعديل القسم" : "إضافة قسم",
    submit: category ? "حفظ" : "إضافة",
    body: `
      <div class="field"><label for="c-name">اسم القسم</label><input id="c-name" name="name" maxlength="120" value="${esc(category?.name ?? "")}" required></div>
      <div class="field"><label for="c-slug">الاسم في الرابط</label><input id="c-slug" name="slug" class="ltr" maxlength="120" value="${esc(category?.slug ?? "")}" placeholder="power-banks" required>
        <span class="hint">حروف إنجليزية صغيرة وأرقام وشرطات.</span></div>
      <div class="field"><label for="c-desc">الوصف (اختياري)</label><input id="c-desc" name="description" maxlength="2000" value="${esc(category?.description ?? "")}"></div>`,
    onSubmit: async (form) => {
      const body = { name: form.name.value.trim(), slug: form.slug.value.trim() };
      const description = form.description.value.trim();
      if (description) body.description = description;
      if (!body.name) throw userError("اسم القسم مطلوب.");
      if (!SLUG.test(body.slug)) throw userError("الاسم في الرابط: حروف إنجليزية صغيرة وأرقام وشرطات فقط.");
      try {
        if (category) await staffApi(`/categories/${category.id}`, { method: "PATCH", body });
        else await staffApi("/categories", { method: "POST", body });
      } catch (err) {
        // 409: قيد UNIQUE على slug في جدول الأقسام.
        if (err.status === 409) throw userError("هذا الاسم في الرابط مستخدم لقسم آخر.");
        throw err;
      }
      toast(category ? "تم حفظ القسم" : "تمت إضافة القسم");
      load().catch((err) => showLoadError(content, errorText(err)));
    },
  });
}
