// دخول الموظفين (admin/login.html). صفحة دخول واحدة للدورين: بعد الدخول يذهب المدير إلى لوحة
// التحكم، والمندوب إلى تطبيق المندوب. الدور يأتي من الخادم في رد الدخول، لا من اختيار المستخدم.
import { staffLogin } from "../../api.js";
import { getStaffSession, saveStaffSession } from "../../store.js";
import { esc, errorText, qs } from "../../ui.js";

const app = document.getElementById("app");

// الصفحة التي نعود إليها بعد الدخول، من ?next=. نقبل فقط اسم صفحة داخل اللوحة بشكل بسيط
// (مثل "order.html?id=..."): أي رابط كامل يُرفض، حتى لا يستغل أحد رابط دخولنا لنقل المدير
// إلى موقع مزيف بعده (Open redirect).
const nextParam = qs("next") ?? "";
const next = /^[a-z-]+\.html(\?[\w=&%.-]*)?$/.test(nextParam) ? nextParam : "index.html";

/** بعد الدخول، أو إن كان الموظف مسجلاً من قبل: كل دور إلى صفحته. */
function goHome(role) {
  location.replace(role === "courier" ? "../courier/index.html" : next);
}

const existing = getStaffSession();
if (existing) {
  goHome(existing.staff.role);
} else {
  render();
}

function render() {
  app.innerHTML = `
    <div class="brand"><img src="../images/logo.svg" alt="AMA"><span>دخول الموظفين</span></div>
    <h1>لوحة المتجر</h1>
    <p>للمدير ومندوبي التوصيل. حسابات الموظفين ينشئها مدير المتجر.</p>
    ${qs("expired") ? `<div class="alert warn">انتهت جلستك أو تغيّرت صلاحيتك. سجّل الدخول من جديد.</div>` : ""}
    <div data-error></div>
    <form novalidate data-form>
      <div class="field"><label for="email">البريد الإلكتروني</label>
        <input id="email" name="email" type="email" class="ltr" autocomplete="username" required></div>
      <div class="field"><label for="password">كلمة المرور</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-lg btn-block">دخول</button>
    </form>
    <div class="auth-foot"><a href="../index.html">العودة إلى المتجر</a></div>`;

  const form = app.querySelector("[data-form]");
  const showError = (message) => {
    app.querySelector("[data-error]").innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : "";
  };
  form.email.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) return showError("أدخل البريد الإلكتروني وكلمة المرور.");
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "جاري الدخول...";
    try {
      const { staff, token } = await staffLogin(email, password);
      saveStaffSession(token, staff);
      goHome(staff.role);
    } catch (err) {
      showError(errorText(err));
      button.disabled = false;
      button.textContent = "دخول";
    }
  });
}
