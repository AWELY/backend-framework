import { api, apiPage, request, ApiError } from "../api.js";
import { getStaff, getStaffToken, saveStaffSession, clearStaffSession, getOwnerKey, setOwnerKey } from "../store.js";
import { esc, errorText } from "../ui.js";

/**
 * أدوات مشتركة بين لوحة الإدارة وتطبيق المندوب.
 *
 * المصادقة: الموظف يدخل ببريده وكلمة مروره (POST /staff/login) فيحصل على توكن جلسة. المالك يستطيع
 * الدخول بمفتاحه (X-Api-Key) لإدارة الموظفين، والمفتاح يُحفظ في sessionStorage فقط (يُنسى بإغلاق التبويب).
 *
 * الصلاحيات هنا للعرض فقط (إخفاء ما لا يستطيع الدور فعله). القرار الحقيقي في الخادم دائماً:
 * زر مخفي لا يحمي شيئاً، و requirePermission في الإطار هو الذي يرد 403.
 * الجدول نسخة من DEFAULT_ROLES في src/engine/access-control.ts.
 */
const ROLE_PERMISSIONS = {
  owner: ["*"],
  admin: ["products:*", "categories:*", "inventory:*", "orders:*", "deliveries:*", "coupons:*", "customers:read", "staff:read", "audit:read"],
  manager: ["products:*", "categories:*", "inventory:*", "orders:read-all", "orders:write", "orders:assign", "deliveries:read-all", "coupons:read", "customers:read", "staff:read"],
  support: ["products:read", "categories:read", "orders:read-all", "orders:write", "deliveries:read-all", "customers:read"],
  courier: ["deliveries:read-own", "deliveries:update-own"],
};

export const ROLE_LABELS = { owner: "المالك", admin: "مدير", manager: "مشرف", support: "خدمة العملاء", courier: "مندوب" };

/** من الداخل الآن: المالك (بمفتاحه) أو موظف، أو null. */
export function identity() {
  if (getOwnerKey()) return { role: "owner", name: "المالك" };
  return getStaffToken() ? getStaff() : null;
}

/** هل يملك الداخل هذه الصلاحية؟ (للعرض فقط) */
export function can(permission) {
  const role = identity()?.role;
  const granted = ROLE_PERMISSIONS[role] ?? [];
  const resource = permission.split(":")[0];
  return granted.some((p) => p === "*" || p === permission || p === `${resource}:*`);
}

export const sapi = (path, options = {}) => api(path, { ...options, auth: "staff" });
export const sapiPage = (path, options = {}) => apiPage(path, { ...options, auth: "staff" });
export const srequest = (path, options = {}) => request(path, { ...options, auth: "staff" });

/** جلسة منتهية أو ملغاة (أُوقف الحساب، أو تغيّر الدور): نخرج ونعود لشاشة الدخول. */
export function isSessionError(err) {
  return err instanceof ApiError && (err.code === "INVALID_TOKEN" || err.code === "INVALID_API_KEY" || err.status === 401);
}

export async function logout() {
  if (getStaffToken() && !getOwnerKey()) await api("/staff/logout", { method: "POST", auth: "staff" }).catch(() => undefined);
  clearStaffSession();
  location.reload();
}

/**
 * شاشة الدخول. allowOwner: يظهر خيار الدخول بمفتاح المالك (لوحة الإدارة فقط).
 * allowedRoles: الأدوار المقبولة في هذا التطبيق (المندوب لا يدخل لوحة الإدارة، والعكس).
 */
export function renderLogin(root, { title, allowOwner, allowedRoles, onSuccess }) {
  root.innerHTML = `
    <div class="panel login-box">
      <div class="logo-row"><img src="images/logo.svg" alt="متجر ماء"></div>
      <h1 class="page-title">${esc(title)}</h1>
      <div data-error></div>
      <form data-staff-login novalidate>
        <div class="field"><label for="s-email">البريد الإلكتروني</label><input id="s-email" name="email" type="email" class="ltr" autocomplete="username" required></div>
        <div class="field"><label for="s-password">كلمة المرور</label><input id="s-password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-block">دخول</button>
      </form>
      ${allowOwner ? `
      <details class="section-box"><summary>الدخول بمفتاح المالك</summary>
        <form data-owner-login novalidate>
          <div class="field"><label for="o-key">مفتاح المالك (OWNER_API_KEY)</label><input id="o-key" name="key" type="password" class="ltr" autocomplete="off" required></div>
          <button class="btn btn-dark btn-block">دخول كمالك</button>
          <p class="muted">لإدارة حسابات الموظفين. يُحفظ في هذا التبويب فقط.</p>
        </form>
      </details>` : ""}
    </div>`;
  const showError = (message) => {
    root.querySelector("[data-error]").innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : "";
  };

  root.querySelector("[data-staff-login]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    showError(null);
    try {
      const result = await api("/staff/login", { method: "POST", auth: "none", body: { email: form.email.value.trim(), password: form.password.value } });
      if (allowedRoles && !allowedRoles.includes(result.staff.role)) {
        // دخل بنجاح لكن هذا التطبيق ليس لدوره: نلغي الجلسة فوراً.
        saveStaffSession(result.token, result.staff);
        await api("/staff/logout", { method: "POST", auth: "staff" }).catch(() => undefined);
        clearStaffSession();
        showError(`هذا التطبيق ليس لدور "${ROLE_LABELS[result.staff.role] ?? result.staff.role}".`);
        return;
      }
      saveStaffSession(result.token, result.staff);
      onSuccess();
    } catch (err) {
      showError(errorText(err));
    }
  });

  root.querySelector("[data-owner-login]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = e.currentTarget.key.value.trim();
    setOwnerKey(key);
    try {
      await sapi("/staff/roles");
      onSuccess();
    } catch (err) {
      setOwnerKey(null);
      showError(err instanceof ApiError && err.status === 401 ? "المفتاح غير صحيح." : errorText(err));
    }
  });
}

/** الشريط العلوي: الشعار، واسم التطبيق، ومن الداخل ودوره، وزر الخروج. */
export function topBar(appName) {
  const who = identity();
  const bar = document.createElement("header");
  bar.className = "staff-top";
  bar.innerHTML = `
    <a class="brand" href="index.html"><img src="images/logo-light.svg" alt="متجر ماء"><span>${esc(appName)}</span></a>
    <div class="who"><span>${esc(who?.name ?? "")}</span><span class="role">${esc(ROLE_LABELS[who?.role] ?? who?.role ?? "")}</span>
      <button type="button" data-logout>خروج</button></div>`;
  bar.querySelector("[data-logout]").addEventListener("click", logout);
  return bar;
}

/**
 * نافذة منبثقة (<dialog>). body: HTML. ترجع { el, close }. تُحذف من الصفحة عند الإغلاق.
 */
export function modal(title, body) {
  const el = document.createElement("dialog");
  el.className = "modal";
  el.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="close" aria-label="إغلاق">×</button></div>
    <div class="modal-body">${body}</div>`;
  document.body.append(el);
  const close = () => {
    el.close();
    el.remove();
  };
  el.querySelector(".close").addEventListener("click", close);
  el.addEventListener("cancel", () => el.remove());
  el.showModal();
  return { el, close };
}

/** شارة ملونة. */
export function pill(text, color = "") {
  return `<span class="pill ${color}">${esc(text)}</span>`;
}

/** المبالغ: الموظف يكتب بالدينار (35.5)، والـ API بالدرهم (35500). */
export const toDirhams = (dinars) => Math.round(Number(dinars) * 1000);
export const toDinars = (dirhams) => (dirhams / 1000).toString();

/** يعرض رسالة خطأ داخل عنصر (data-msg). */
export function showMessage(root, message, type = "error") {
  const box = root.querySelector("[data-msg]");
  if (box) box.innerHTML = message ? `<div class="alert ${type}">${esc(message)}</div>` : "";
}
