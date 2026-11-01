import { api, logoutCustomer } from "../api.js";
import { getToken, saveSession, getCartId, setCartId } from "../store.js";
import { mountLayout, esc, errorText, qs, formatDate, toast } from "../ui.js";

/**
 * حسابي: الدخول، والتسجيل، ونسيت كلمة المرور، والملف الشخصي، وتغيير كلمة المرور، والأجهزة الداخلة.
 *
 * ما تستخدمه من الإطار:
 *   - POST /customers/login و /register مع guestCartId: سلة الضيف تُدمج في سلة الحساب.
 *   - POST /customers/logout (هذا الجهاز) و /logout-all (كل الأجهزة): الجلسة تُلغى في الخادم.
 *   - GET /customers/me/sessions: الأجهزة الداخلة الآن.
 *   - POST /customers/me/password: يُخرج كل الأجهزة الأخرى.
 *   - PATCH /customers/me بـ phone: null يمسح الهاتف.
 *   - POST /customers/password-reset: الرابط يصل بالحدث customer.passwordResetRequested
 *     (في التطوير: صندوق البريد التجريبي GET /dev/mailbox).
 */
mountLayout("account");
const app = document.getElementById("app");

const next = /^[a-z-]+\.html$/.test(qs("next") ?? "") ? qs("next") : "orders.html";

async function render() {
  if (getToken()) {
    const me = await api("/customers/me").catch(() => null);
    if (me) return renderProfile(me);
  }
  renderForms(qs("tab") === "forgot" ? "forgot" : "login");
}

async function renderProfile(me) {
  const sessions = await api("/customers/me/sessions").catch(() => []);
  app.innerHTML = `
    <h1 class="page-title">حسابي</h1>
    <div class="layout-2">
      <section class="panel">
        <h3>بياناتي</h3>
        <div data-profile-msg></div>
        <form data-profile novalidate>
          <div class="field"><label for="p-name">الاسم</label><input id="p-name" name="name" value="${esc(me.name)}" required></div>
          <div class="field"><label>البريد الإلكتروني</label><input value="${esc(me.email)}" class="ltr" disabled></div>
          <div class="field"><label for="p-phone">الهاتف (اتركه فارغاً لحذفه)</label><input id="p-phone" name="phone" type="tel" class="ltr" value="${esc(me.phone ?? "")}"></div>
          <button class="btn">حفظ التعديلات</button>
        </form>
        <h3>تغيير كلمة المرور</h3>
        <div data-password-msg></div>
        <form data-password novalidate>
          <div class="field"><label for="cur">كلمة المرور الحالية</label><input id="cur" name="currentPassword" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="new">كلمة المرور الجديدة (8 أحرف على الأقل)</label><input id="new" name="newPassword" type="password" autocomplete="new-password" minlength="8" required></div>
          <button class="btn btn-light">تغيير كلمة المرور</button>
          <p class="muted">بعد التغيير تخرج كل الأجهزة الأخرى من حسابك، ويبقى هذا الجهاز.</p>
        </form>
      </section>
      <aside class="panel">
        <a class="btn btn-block" href="orders.html">طلباتي</a>
        <h3>الأجهزة الداخلة الآن</h3>
        <ul class="sessions-list">
          ${sessions.map((s) => `<li><b>${s.current ? "هذا الجهاز" : "جهاز آخر"}</b><span class="muted">${esc(formatDate(s.createdAt))}${s.userAgent ? ` — ${esc(s.userAgent.slice(0, 40))}` : ""}</span></li>`).join("")}
        </ul>
        <button class="btn btn-light btn-block" data-logout>تسجيل الخروج</button>
        <button class="btn btn-light btn-block" data-logout-all>الخروج من كل الأجهزة</button>
      </aside>
    </div>`;

  const message = (selector, text, type = "info") => {
    app.querySelector(selector).innerHTML = text ? `<div class="alert ${type}">${esc(text)}</div>` : "";
  };

  app.querySelector("[data-profile]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const phone = form.phone.value.trim();
    try {
      const updated = await api("/customers/me", { method: "PATCH", body: { name: form.name.value.trim(), phone: phone || null } });
      saveSession(getToken(), updated);
      message("[data-profile-msg]", "تم حفظ بياناتك.");
    } catch (err) {
      message("[data-profile-msg]", errorText(err), "error");
    }
  });

  app.querySelector("[data-password]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/customers/me/password", { method: "POST", body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value } });
      form.reset();
      message("[data-password-msg]", "تم تغيير كلمة المرور، وخرجت الأجهزة الأخرى من حسابك.");
    } catch (err) {
      message("[data-password-msg]", errorText(err), "error");
    }
  });

  app.querySelector("[data-logout]").addEventListener("click", async () => {
    await logoutCustomer();
    location.href = "index.html";
  });
  app.querySelector("[data-logout-all]").addEventListener("click", async () => {
    await logoutCustomer({ everywhere: true });
    toast("خرجت من كل الأجهزة");
    location.href = "index.html";
  });
}

function renderForms(tab) {
  const tabs = { login: "تسجيل الدخول", register: "حساب جديد", forgot: "نسيت كلمة المرور" };
  app.innerHTML = `
    <h1 class="page-title">حسابي</h1>
    <div class="panel narrow">
      <div class="tabs">${Object.entries(tabs).map(([k, label]) => `<button type="button" data-tab="${k}" class="${tab === k ? "active" : ""}">${label}</button>`).join("")}</div>
      <div data-error></div>
      ${tab === "login" ? `
      <form data-login novalidate>
        <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required></div>
        <div class="field"><label for="password">كلمة المرور</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-block">دخول</button>
      </form>` : tab === "register" ? `
      <form data-register novalidate>
        <div class="field"><label for="name">الاسم الكامل</label><input id="name" name="name" autocomplete="name" required></div>
        <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required></div>
        <div class="field"><label for="phone">رقم الهاتف (اختياري)</label><input id="phone" name="phone" type="tel" class="ltr" placeholder="09XXXXXXXX" autocomplete="tel"></div>
        <div class="field"><label for="password">كلمة المرور (8 أحرف على الأقل)</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn btn-block">إنشاء الحساب</button>
      </form>` : `
      <form data-forgot novalidate>
        <p class="muted">أدخل بريدك، وسنرسل لك رابطاً لتعيين كلمة مرور جديدة (صالح 30 دقيقة).</p>
        <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="email" required></div>
        <button class="btn btn-block">أرسل الرابط</button>
      </form>
      <div data-mailbox></div>`}
      <p class="muted">الحساب اختياري — يمكنك الشراء كضيف وتتبّع طلبك برقم الطلب ورقم هاتفك.</p>
    </div>`;

  app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => renderForms(b.dataset.tab)));
  const showError = (message, type = "error") => {
    app.querySelector("[data-error]").innerHTML = message ? `<div class="alert ${type}">${esc(message)}</div>` : "";
  };

  const form = app.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    const data = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(data)) {
      data[key] = String(data[key]).trim();
      if (data[key] === "") delete data[key];
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      if (form.hasAttribute("data-forgot")) {
        await api("/customers/password-reset", { method: "POST", body: data });
        showError("إن كان البريد مسجلاً عندنا، ستصلك رسالة فيها الرابط.", "info");
        showDevMailbox(data.email);
        button.disabled = false;
        return;
      }
      // سلة الضيف تُرسل مع الدخول أو التسجيل، فيدمجها الخادم في سلة الحساب.
      const guestCartId = getCartId();
      const path = form.hasAttribute("data-login") ? "/customers/login" : "/customers/register";
      const result = await api(path, { method: "POST", body: { ...data, ...(guestCartId ? { guestCartId } : {}) } });
      saveSession(result.token, result.customer);
      if (result.cartId) setCartId(result.cartId);
      location.href = next;
    } catch (err) {
      showError(errorText(err));
      button.disabled = false;
    }
  });
}

/**
 * في وضع التجربة فقط: يعرض رسالة الاستعادة من صندوق البريد التجريبي (إضافة dev-mailbox في المتجر)،
 * لأن المتجر في التطوير لا يرسل بريداً حقيقياً. في الإنتاج المسار غير موجود فلا يظهر شيء.
 */
async function showDevMailbox(email) {
  await new Promise((r) => setTimeout(r, 800));
  const messages = await api(`/dev/mailbox?to=${encodeURIComponent(email)}`, { auth: "none" }).catch(() => []);
  const reset = messages.find((m) => m.subject === "استعادة كلمة المرور");
  if (!reset) return;
  app.querySelector("[data-mailbox]").innerHTML = `
    <div class="dev-hint"><b>وضع التجربة — صندوق البريد:</b>
      <a href="${esc(reset.text.replace(/^https?:\/\/[^/]+\//, ""))}" data-reset-link>افتح رابط تعيين كلمة المرور</a></div>`;
}

render().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">حدث خطأ</div><p>${esc(errorText(err))}</p></div>`;
});
