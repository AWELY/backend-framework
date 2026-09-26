import { api } from "../api.js";
import { getToken, saveSession, clearSession } from "../store.js";
import { mountLayout, esc, errorText, qs } from "../ui.js";

mountLayout("account");
const app = document.getElementById("app");

// Only local pages are allowed as a destination after login (no open redirect).
const next = /^[a-z-]+\.html$/.test(qs("next") ?? "") ? qs("next") : "orders.html";

async function render() {
  if (getToken()) {
    const me = await api("/customers/me").catch(() => null);
    if (me) return renderProfile(me);
  }
  renderForms("login");
}

function renderProfile(me) {
  app.innerHTML = `
    <h1 class="page-title">حسابي</h1>
    <div class="panel narrow">
      <p><b>الاسم:</b> ${esc(me.name)}</p>
      <p><b>البريد الإلكتروني:</b> <span class="ltr">${esc(me.email)}</span></p>
      <p><b>الهاتف:</b> <span class="ltr">${esc(me.phone ?? "—")}</span></p>
      <a class="btn btn-block" href="orders.html">طلباتي</a>
      <p></p>
      <button class="btn btn-light btn-block" data-logout>تسجيل الخروج</button>
    </div>`;
  app.querySelector("[data-logout]").addEventListener("click", () => {
    clearSession();
    location.href = "index.html";
  });
}

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
    const data = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(data)) {
      data[key] = String(data[key]).trim();
      if (data[key] === "") delete data[key];
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const path = form.hasAttribute("data-login") ? "/customers/login" : "/customers/register";
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
