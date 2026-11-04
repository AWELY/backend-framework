// الإطار المشترك لمنطقة حساب الزبون (صفحتا "طلباتي" و"بياناتي"): قائمة جانبية فيها اسم الزبون
// والرابطان وزر الخروج، والمحتوى بجانبها. على الهاتف تصبح القائمة شريطاً أفقياً أعلى المحتوى.
import { clearSession } from "./store.js";
import { esc, icon } from "./ui.js";

/**
 * يرسم الإطار داخل app ويرجع العنصر الذي يُكتب فيه محتوى الصفحة.
 *   active : "orders" أو "profile"، لتمييز الرابط الحالي.
 *   me     : بيانات الزبون من GET /customers/me (الاسم والبريد).
 */
export function accountShell(app, active, me, title) {
  app.innerHTML = `
    <h1 class="page-title">${esc(title)}</h1>
    <div class="account-layout">
      <nav class="account-nav" aria-label="حسابي">
        <div class="who"><b>${esc(me.name)}</b><span class="ltr">${esc(me.email)}</span></div>
        <a href="orders.html" class="${active === "orders" ? "active" : ""}">${icon("package", 20)} طلباتي</a>
        <a href="account.html" class="${active === "profile" ? "active" : ""}">${icon("user", 20)} بياناتي</a>
        <button type="button" data-logout>${icon("logout", 20)} تسجيل الخروج</button>
      </nav>
      <section data-account-content></section>
    </div>`;
  // الخروج: نمسح التوكن من المتصفح ونعود للرئيسية. (التوكن في الإطار بلا جلسة في الخادم،
  // فالخروج يعني ببساطة أن ينساه المتصفح.)
  app.querySelector("[data-logout]").addEventListener("click", () => {
    clearSession();
    location.href = "index.html";
  });
  return app.querySelector("[data-account-content]");
}
