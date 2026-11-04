// صفحة الموظفين في لوحة التحكم (admin/staff.html): حسابات المديرين ومندوبي التوصيل.
// إضافة حساب، وتعديل الاسم والهاتف، وتغيير كلمة المرور، وإيقاف الحساب وإعادة تفعيله.
// كل ذلك من إضافة الموظفين (storefront/api/plugins/staff.js)، بصلاحية staff:manage.
import { requireAdmin, mountAdmin, staffApi, esc, icon, money, errorText, toast, showLoadError, openDialog, userError, formatDate } from "../common.js";

const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;
const ROLE = { admin: "مدير", courier: "مندوب توصيل" };

const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, {
    active: "staff",
    title: "الموظفون والمندوبون",
    actions: `<button class="btn btn-sm" data-new>${icon("plus", 18)} إضافة موظف</button>`,
  });
  document.querySelector("[data-new]").addEventListener("click", createDialog);
  load().catch((err) => showLoadError(content, errorText(err)));
}

async function load() {
  // الحسابات، وملخص عمل المندوبين اليوم (إضافة التوصيل) لعرضه بجانب كل مندوب.
  const [staff, couriers] = await Promise.all([staffApi("/staff"), staffApi("/deliveries/couriers")]);
  const work = new Map(couriers.map((c) => [c.id, c]));

  content.innerHTML = `
    <div class="alert info">المندوب يدخل من <a href="../courier/index.html" target="_blank" rel="noopener">تطبيق المندوب</a> على هاتفه بالبريد وكلمة المرور التي تنشئها هنا. الحساب الموقوف لا يستطيع الدخول ولا تنفيذ أي توصيل.</div>
    <section class="box">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>الاسم</th><th>الدور</th><th>الهاتف</th><th>اليوم</th><th>الحساب نشط</th><th></th></tr></thead>
        <tbody>${staff.map((m) => {
          const w = work.get(m.id);
          const isMe = m.id === session.staff.id;
          return `<tr class="${m.isActive ? "" : "inactive"}" data-id="${esc(m.id)}">
            <td><b>${esc(m.name)}</b>${isMe ? ` <span class="muted">(أنت)</span>` : ""}<span class="sub ltr">${esc(m.email)}</span></td>
            <td>${ROLE[m.role] ?? esc(m.role)}</td>
            <td class="ltr">${m.phone ? esc(m.phone) : "—"}</td>
            <td>${w ? `معه ${w.active}، سلّم ${w.deliveredToday}<span class="sub">حصّل ${money(w.cashToday)}</span>` : `<span class="muted">—</span>`}</td>
            <td><input type="checkbox" class="switch" ${m.isActive ? "checked" : ""} ${isMe ? "disabled" : ""} aria-label="تفعيل حساب ${esc(m.name)}" data-active></td>
            <td><div class="action-row">
              <button class="btn btn-sm btn-light" data-edit>${icon("edit", 16)} تعديل</button>
              <button class="btn btn-sm btn-light" data-password>كلمة المرور</button>
            </div></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <div class="pager"><span>${staff.length} حساب</span><span class="muted">أُنشئ أقدمها في ${staff.length ? esc(formatDate(staff.map((m) => m.createdAt).sort()[0])) : "—"}</span></div>
    </section>`;

  content.querySelectorAll("tr[data-id]").forEach((tr) => {
    const member = staff.find((m) => m.id === tr.dataset.id);
    // الإيقاف والتفعيل: الخادم يرفض إيقاف المدير لحسابه هو (والمفتاح معطّل له هنا أصلاً).
    tr.querySelector("[data-active]").addEventListener("change", async (e) => {
      const isActive = e.target.checked;
      if (!isActive && !confirm(`إيقاف حساب ${member.name}؟ لن يستطيع الدخول حتى تعيد تفعيله.`)) {
        e.target.checked = true;
        return;
      }
      try {
        await staffApi(`/staff/${member.id}`, { method: "PATCH", body: { isActive } });
        toast(isActive ? "تم تفعيل الحساب" : "تم إيقاف الحساب");
        load().catch((err) => showLoadError(content, errorText(err)));
      } catch (err) {
        e.target.checked = !isActive;
        toast(errorText(err), "error");
      }
    });
    tr.querySelector("[data-edit]").addEventListener("click", () => editDialog(member));
    tr.querySelector("[data-password]").addEventListener("click", () => passwordDialog(member));
  });
}

/** نافذة إضافة موظف: الدور يُختار مرة واحدة عند الإنشاء ولا يتغير بعدها. */
function createDialog() {
  openDialog({
    title: "إضافة موظف",
    submit: "إنشاء الحساب",
    body: `
      <div class="field"><label for="s-role">الدور</label>
        <select id="s-role" name="role"><option value="courier">مندوب توصيل</option><option value="admin">مدير (كل صلاحيات اللوحة)</option></select></div>
      <div class="field"><label for="s-name">الاسم</label><input id="s-name" name="name" maxlength="120" required></div>
      <div class="field"><label for="s-email">البريد الإلكتروني (اسم الدخول)</label><input id="s-email" name="email" type="email" class="ltr" maxlength="254" required></div>
      <div class="field"><label for="s-phone">الهاتف (اختياري)</label><input id="s-phone" name="phone" type="tel" class="ltr" placeholder="09XXXXXXXX"></div>
      <div class="field"><label for="s-pass">كلمة المرور</label><input id="s-pass" name="password" type="text" class="ltr" minlength="8" maxlength="128" autocomplete="new-password" required>
        <span class="hint">8 أحرف على الأقل. أعطها للموظف، ويستطيع المدير تغييرها لاحقاً.</span></div>`,
    onSubmit: async (form) => {
      const body = {
        role: form.role.value,
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value,
      };
      const phone = form.phone.value.trim();
      if (phone) body.phone = phone;
      if (!body.name) throw userError("الاسم مطلوب.");
      if (!body.email.includes("@")) throw userError("أدخل بريداً إلكترونياً صحيحاً.");
      if (phone && !PHONE.test(phone)) throw userError("رقم الهاتف غير صحيح.");
      if (body.password.length < 8) throw userError("كلمة المرور 8 أحرف على الأقل.");
      try {
        await staffApi("/staff", { method: "POST", body });
      } catch (err) {
        if (err.status === 409) throw userError("هذا البريد مسجل لموظف آخر.");
        throw err;
      }
      toast(`تم إنشاء حساب ${body.name}`);
      load().catch((err) => showLoadError(content, errorText(err)));
    },
  });
}

/** نافذة تعديل الاسم والهاتف. */
function editDialog(member) {
  openDialog({
    title: `تعديل ${member.name}`,
    body: `
      <div class="field"><label for="e-name">الاسم</label><input id="e-name" name="name" maxlength="120" value="${esc(member.name)}" required></div>
      <div class="field"><label for="e-phone">الهاتف</label><input id="e-phone" name="phone" type="tel" class="ltr" value="${esc(member.phone ?? "")}"></div>`,
    onSubmit: async (form) => {
      const body = { name: form.name.value.trim() };
      const phone = form.phone.value.trim();
      if (!body.name) throw userError("الاسم مطلوب.");
      if (phone) {
        if (!PHONE.test(phone)) throw userError("رقم الهاتف غير صحيح.");
        body.phone = phone;
      }
      await staffApi(`/staff/${member.id}`, { method: "PATCH", body });
      toast("تم الحفظ");
      load().catch((err) => showLoadError(content, errorText(err)));
    },
  });
}

/** نافذة تعيين كلمة مرور جديدة (مثلاً موظف نسي كلمته). الخادم يحفظ hash الكلمة فقط. */
function passwordDialog(member) {
  openDialog({
    title: `كلمة مرور جديدة لـ ${member.name}`,
    submit: "تغيير كلمة المرور",
    body: `<div class="field"><label for="p-new">كلمة المرور الجديدة</label><input id="p-new" name="password" type="text" class="ltr" minlength="8" maxlength="128" autocomplete="new-password" required>
      <span class="hint">8 أحرف على الأقل.</span></div>`,
    onSubmit: async (form) => {
      const password = form.password.value;
      if (password.length < 8) throw userError("كلمة المرور 8 أحرف على الأقل.");
      await staffApi(`/staff/${member.id}`, { method: "PATCH", body: { password } });
      toast("تم تغيير كلمة المرور");
    },
  });
}
