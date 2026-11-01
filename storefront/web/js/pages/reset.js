import { api } from "../api.js";
import { mountLayout, esc, errorText, qs } from "../ui.js";

/**
 * تعيين كلمة مرور جديدة برابط الاستعادة (reset.html?token=...).
 * POST /customers/password-reset/confirm يستهلك الرمز (مرة واحدة)، ويُخرج كل الأجهزة من الحساب.
 */
mountLayout("account");
const app = document.getElementById("app");
const token = qs("token") ?? "";

app.innerHTML = `
  <h1 class="page-title">كلمة مرور جديدة</h1>
  <form class="panel narrow" data-form novalidate>
    <div data-msg></div>
    ${token ? `
    <div class="field"><label for="pw">كلمة المرور الجديدة (8 أحرف على الأقل)</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="field"><label for="pw2">أعد كتابتها</label><input id="pw2" name="confirm" type="password" autocomplete="new-password" required></div>
    <button class="btn btn-block">حفظ كلمة المرور</button>` : `<div class="alert error">الرابط ناقص. اطلب رابطاً جديداً من <a href="account.html?tab=forgot"><u>نسيت كلمة المرور</u></a>.</div>`}
  </form>`;

const form = app.querySelector("[data-form]");
const msg = (text, type) => {
  app.querySelector("[data-msg]").innerHTML = `<div class="alert ${type}">${text}</div>`;
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (form.password.value.length < 8) return msg("كلمة المرور قصيرة (8 أحرف على الأقل).", "error");
  if (form.password.value !== form.confirm.value) return msg("الكلمتان غير متطابقتين.", "error");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api("/customers/password-reset/confirm", { method: "POST", auth: "none", body: { token, password: form.password.value } });
    form.innerHTML = `<div class="alert info">تم تعيين كلمة المرور. خرجت كل الأجهزة من حسابك.</div><a class="btn btn-block" href="account.html">سجّل الدخول</a>`;
  } catch (err) {
    msg(esc(errorText(err)), "error");
    button.disabled = false;
  }
});
