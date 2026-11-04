// صفحة الحساب (account.html): الدخول، وإنشاء حساب جديد، و"بياناتي" (تعديل الاسم والهاتف) للمسجل.
// الحساب اختياري: الضيف يستطيع الشراء وتتبع طلبه دون حساب.
import { api } from "../api.js";
import { getToken, saveSession, updateSessionCustomer } from "../store.js";
import { mountLayout, esc, errorText, qs, toast } from "../ui.js";
import { accountShell } from "../account-shell.js";

mountLayout("account");
const app = document.getElementById("app");

// الصفحة التي ننتقل إليها بعد الدخول، من ?next= في الرابط (مثلاً العودة إلى إتمام الطلب).
// نقبل فقط اسم صفحة محلية بسيطة مثل "checkout.html"، ولا نقبل رابطاً كاملاً. لو قبلنا أي
// رابط، لاستطاع مهاجم إرسال رابط دخول حقيقي لمتجرنا ينقل الضحية بعده إلى موقع مزيف
// (هجوم اسمه Open redirect). أي قيمة أخرى تعطي "orders.html".
const next = /^[a-z-]+\.html$/.test(qs("next") ?? "") ? qs("next") : "orders.html";

/** المسجل دخوله يرى ملفه، والزائر يرى نموذج الدخول. */
async function render() {
  if (getToken()) {
    // توكن منتهٍ: catch ترجع null، فيظهر نموذج الدخول بدل خطأ.
    const me = await api("/customers/me").catch(() => null);
    if (me) return renderProfile(me);
  }
  renderForms("login");
}

// نفس قاعدة الهاتف في الـ API، لرسالة فورية قبل الإرسال (الخادم يفحص مرة أخرى دائماً).
const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;

/**
 * "بياناتي": الاسم والهاتف قابلان للتعديل (PATCH /customers/me في الإطار)، والبريد للعرض فقط
 * (الإطار لا يسمح بتغييره من هذا المسار). الهاتف المحفوظ هنا يُملأ تلقائياً عند إتمام الطلب.
 */
function renderProfile(me) {
  const content = accountShell(app, "profile", me, "بياناتي");
  content.innerHTML = `
    <form class="panel" data-profile novalidate>
      <div data-error></div>
      <div class="field"><label>البريد الإلكتروني</label><input class="ltr" value="${esc(me.email)}" disabled>
        <span class="hint">البريد هو اسم الدخول، ولا يمكن تغييره.</span></div>
      <div class="field"><label for="name">الاسم الكامل</label><input id="name" name="name" autocomplete="name" value="${esc(me.name)}" required></div>
      <div class="field"><label for="phone">رقم الهاتف</label><input id="phone" name="phone" type="tel" class="ltr" placeholder="09XXXXXXXX" autocomplete="tel" value="${esc(me.phone ?? "")}">
        <span class="hint">نستخدمه لتأكيد طلباتك، ويُملأ تلقائياً عند الشراء.</span></div>
      <button class="btn">حفظ التغييرات</button>
    </form>`;
  const form = content.querySelector("[data-profile]");
  const showError = (message) => {
    form.querySelector("[data-error]").innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : "";
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    if (!name) return showError("الاسم مطلوب.");
    if (phone && !PHONE.test(phone)) return showError("أدخل رقم هاتف صحيح، مثال: 0912345678");
    // نرسل الهاتف فقط إن كُتب: الـ API يرفض الحقل الفارغ (صيغته غير صحيحة).
    const body = phone ? { name, phone } : { name };
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const updated = await api("/customers/me", { method: "PATCH", body });
      // الاسم الجديد يظهر في الرأس وفي القائمة الجانبية بعد إعادة الرسم.
      updateSessionCustomer(updated);
      const headerName = document.querySelector('.nav a[href="orders.html"] .label');
      if (headerName) headerName.textContent = updated.name;
      toast("تم حفظ بياناتك");
      renderProfile(updated);
    } catch (err) {
      showError(errorText(err));
      button.disabled = false;
    }
  });
}

/**
 * نموذجا الدخول والتسجيل في تبويبين. tab: أي التبويبين ظاهر ("login" أو "register").
 * التبديل بين التبويبين يعيد رسم الصفحة بالتبويب الآخر.
 */
function renderForms(tab) {
  app.innerHTML = `
    <h1 class="page-title">حسابي</h1>
    <div class="panel narrow">
      <div class="tabs">
        <button type="button" data-tab="login" class="${tab === "login" ? "active" : ""}">تسجيل الدخول</button>
        <button type="button" data-tab="register" class="${tab === "register" ? "active" : ""}">حساب جديد</button>
      </div>
      <div data-error></div>
      ${tab === "login" ? `
      <form data-login novalidate>
        <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required></div>
        <div class="field"><label for="password">كلمة المرور</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-block">دخول</button>
      </form>` : `
      <form data-register novalidate>
        <div class="field"><label for="name">الاسم الكامل</label><input id="name" name="name" autocomplete="name" required></div>
        <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required></div>
        <div class="field"><label for="phone">رقم الهاتف (اختياري)</label><input id="phone" name="phone" type="tel" class="ltr" placeholder="09XXXXXXXX" autocomplete="tel"></div>
        <div class="field"><label for="password">كلمة المرور (8 أحرف على الأقل)</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn btn-block">إنشاء الحساب</button>
      </form>`}
      <p class="muted">الحساب اختياري — يمكنك الشراء كضيف وتتبّع طلبك برقم الطلب ورقم هاتفك.</p>
    </div>`;

  app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => renderForms(b.dataset.tab)));
  const showError = (message) => {
    app.querySelector("[data-error]").innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : "";
  };

  const form = app.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    // FormData يقرأ كل حقول النموذج بأسمائها (name)، و Object.fromEntries يحوّلها إلى كائن.
    const data = Object.fromEntries(new FormData(form));
    // نحذف المسافات حول القيم، ونحذف الحقول الفارغة (مثل الهاتف الاختياري)، لأن الـ API
    // يرفض الحقل الفارغ إن أُرسل، ويقبل غيابه.
    for (const key of Object.keys(data)) {
      data[key] = String(data[key]).trim();
      if (data[key] === "") delete data[key];
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const path = form.hasAttribute("data-login") ? "/customers/login" : "/customers/register";
      // الرد في الحالتين: { customer, token }. نحفظ الجلسة، ثم ننتقل.
      const result = await api(path, { method: "POST", body: data });
      saveSession(result.token, result.customer);
      location.href = next;
    } catch (err) {
      showError(errorText(err));
      button.disabled = false;
    }
  });
}

render().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">حدث خطأ</div><p>${esc(errorText(err))}</p></div>`;
});
