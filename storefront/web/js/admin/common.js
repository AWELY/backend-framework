// أدوات مشتركة بين كل صفحات لوحة التحكم (web/admin): حماية الصفحات بالدخول، والهيكل (القائمة
// الجانبية والرأس)، وأسماء الحالات بالعربية، والنافذة المنبثقة.
//
// اللوحة "عميل" آخر للـ API نفسه، مثل الموقع تماماً (Headless): لا تتصل بقاعدة البيانات، بل
// ترسل طلبات HTTP بتوكن المدير. أغلب ما تستخدمه مسارات الإطار نفسها (المنتجات، والطلبات،
// والمخزون، والأقسام، والزبائن)، والباقي من إضافات المتجر (الموظفون، والتوصيل، والتقارير).
import { staffApi, setStaffExpiredHandler } from "../api.js";
import { getStaffSession, clearStaffSession } from "../store.js";
import { esc, icon, errorText } from "../ui.js";

// نعيد تصدير ما تحتاجه كل صفحة، فتستورد من ملف واحد.
export { staffApi };
export { esc, icon, money, formatDate, errorText, toast, qs, priceHtml } from "../ui.js";

// صورة بديلة للمنتج بلا صورة. المسار نسبي من مجلد admin.
export const PLACEHOLDER = "../images/placeholder.svg";

// أسماء حالات الطلب كما يحتاجها المدير (أدق من أسماء الزبون: "جديد" بدل "قيد المراجعة").
export const STATUS = {
  pending: "جديد، بانتظار التأكيد",
  confirmed: "مؤكد",
  shipped: "في الطريق",
  delivered: "تم التسليم",
  cancelled: "ملغي",
};
// أسماء مختصرة للتبويبات والجداول.
export const STATUS_SHORT = { pending: "جديد", confirmed: "مؤكد", shipped: "في الطريق", delivered: "تم التسليم", cancelled: "ملغي" };

// حالات الدفع للمدير. "pending" في هذا المتجر تعني: الدفع عند الاستلام، ولم يُحصَّل بعد.
export const PAYMENT = {
  unpaid: "غير مدفوع",
  pending: "لم يُحصَّل بعد",
  paid: "مدفوع",
  failed: "فشل الدفع",
  refunded: "مسترجع",
};

/** شارة حالة الطلب أو الدفع، بنفس ألوان .status في styles.css. */
export const statusChip = (status, labels = STATUS_SHORT) => `<span class="status ${esc(status)}">${esc(labels[status] ?? status)}</span>`;

/** أول 8 أحرف من رقم الطلب، تكفي للتعرف عليه في الجداول (الرقم الكامل في صفحة الطلب). */
export const shortId = (id) => String(id).slice(0, 8);

/** "منذ 5 دقائق" أو "منذ 3 ساعات"، وللأقدم من يومين: التاريخ نفسه. */
export function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `منذ ${minutes} د`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${hours} س`;
  if (hours < 48) return "أمس";
  return new Date(iso).toLocaleDateString("ar-LY", { day: "numeric", month: "short" });
}

/** يحوّل مبلغاً بالدينار من حقل إدخال (مثل "12.5") إلى دراهم (12500)، كما يخزنها الإطار. */
export const toDirhams = (lyd) => Math.round(Number(lyd) * 1000);
/** العكس: من دراهم إلى رقم بالدينار لحقل الإدخال. */
export const toLyd = (dirhams) => String(dirhams / 1000);

/**
 * يتأكد أن في المتصفح جلسة مدير، وإلا ينقل إلى صفحة الدخول مع ?next= للعودة إلى هذه الصفحة.
 * يرجع الجلسة، أو null (والصفحة تتوقف عندها). جلسة مندوب تذهب إلى تطبيق المندوب.
 *
 * هذا الفحص للراحة فقط: الحماية الحقيقية في الخادم، الذي يرفض أي طلب بلا صلاحية.
 */
export function requireAdmin() {
  const session = getStaffSession();
  if (session?.staff.role === "courier") {
    location.replace("../courier/index.html");
    return null;
  }
  if (session?.staff.role !== "admin") {
    const here = location.pathname.split("/").pop() + location.search;
    location.replace(`login.html?next=${encodeURIComponent(here)}`);
    return null;
  }
  // انتهت الجلسة أثناء العمل (401 من الخادم): إلى الدخول، ثم العودة لنفس الصفحة.
  setStaffExpiredHandler(() => {
    const here = location.pathname.split("/").pop() + location.search;
    location.replace(`login.html?expired=1&next=${encodeURIComponent(here)}`);
  });
  return session;
}

// روابط القائمة الجانبية: [المفتاح، الصفحة، الأيقونة، الاسم].
const LINKS = [
  ["dashboard", "index.html", "dashboard", "الرئيسية"],
  ["orders", "orders.html", "receipt", "الطلبات"],
  ["products", "products.html", "box", "المنتجات"],
  ["categories", "categories.html", "tag", "الأقسام"],
  ["customers", "customers.html", "users", "الزبائن"],
  ["staff", "staff.html", "bike", "الموظفون والمندوبون"],
];

/**
 * يبني هيكل اللوحة: القائمة الجانبية، والرأس بعنوان الصفحة وأزرارها، ومكان المحتوى.
 *   active  : مفتاح الصفحة الحالية في LINKS.
 *   title   : عنوان الصفحة (يظهر في الرأس وفي تبويب المتصفح).
 *   actions : HTML لأزرار في الرأس (مثل "إضافة منتج").
 * يرجع عنصر المحتوى الذي ترسم فيه الصفحة.
 */
export function mountAdmin(session, { active, title, actions = "" }) {
  document.title = `${title} | لوحة متجر AMA`;
  document.body.innerHTML = `
    <div class="admin">
      <aside class="side" id="side" aria-label="القائمة">
        <a class="side-brand" href="index.html"><img src="../images/logo-light.svg" alt="AMA"><span>لوحة المتجر</span></a>
        <nav class="side-nav">${LINKS.map(([key, href, ic, label]) => `
          <a href="${href}" class="${key === active ? "active" : ""}" ${key === active ? 'aria-current="page"' : ""}>${icon(ic, 20)} ${label}${key === "orders" ? '<span class="count hidden" data-pending-count></span>' : ""}</a>`).join("")}
        </nav>
        <div class="side-foot">
          <div class="me"><b>${esc(session.staff.name)}</b><span>حساب مدير</span></div>
          <a href="../index.html" target="_blank" rel="noopener">${icon("external", 18)} عرض المتجر</a>
          <button type="button" data-logout>${icon("logout", 18)} تسجيل الخروج</button>
        </div>
      </aside>
      <div class="admin-main">
        <header class="admin-top">
          <button class="menu-btn" type="button" aria-label="القائمة" aria-controls="side" aria-expanded="false" data-menu>${icon("menu", 22)}</button>
          <h1>${esc(title)}</h1>
          <div class="actions">${actions}</div>
        </header>
        <main class="admin-content" id="content"><div class="loading">جاري التحميل...</div></main>
      </div>
    </div>`;

  // زر القائمة على الهاتف: يفتح القائمة الجانبية، وخلفية شفافة تغلقها عند الضغط خارجها.
  const side = document.getElementById("side");
  const menu = document.querySelector("[data-menu]");
  menu.addEventListener("click", () => {
    side.classList.add("open");
    menu.setAttribute("aria-expanded", "true");
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.addEventListener("click", () => {
      side.classList.remove("open");
      menu.setAttribute("aria-expanded", "false");
      scrim.remove();
    });
    document.body.append(scrim);
  });

  // الخروج: ننسى التوكن في المتصفح (التوكن بلا جلسة في الخادم، كتوكن الزبون).
  document.querySelector("[data-logout]").addEventListener("click", () => {
    clearStaffSession();
    location.href = "login.html";
  });

  refreshPendingCount();
  return document.getElementById("content");
}

/**
 * عدد الطلبات الجديدة (بانتظار التأكيد) بجانب "الطلبات" في القائمة، ليعرف المدير من أي صفحة
 * أن هناك ما ينتظره. مسار الإطار نفسه: GET /orders?status=pending (حد أقصى 100 في الصفحة).
 */
export async function refreshPendingCount() {
  const badge = document.querySelector("[data-pending-count]");
  if (!badge) return;
  try {
    const pending = await staffApi("/orders?status=pending&limit=100");
    badge.textContent = pending.length >= 100 ? "+99" : String(pending.length);
    badge.classList.toggle("hidden", pending.length === 0);
  } catch {
    badge.classList.add("hidden");
  }
}

/** رسالة خطأ داخل منطقة المحتوى، مع زر لإعادة المحاولة. */
export function showLoadError(content, message) {
  content.innerHTML = `<div class="box empty"><div class="big">تعذّر تحميل الصفحة</div><p>${esc(message)}</p>
    <button class="btn" data-retry>إعادة المحاولة</button></div>`;
  content.querySelector("[data-retry]").addEventListener("click", () => location.reload());
}

/**
 * نافذة منبثقة بنموذج، بعنصر <dialog> الأصلي في المتصفح (لا مكتبة، ويعمل مع CSP).
 *   title    : عنوان النافذة.
 *   body     : HTML حقول النموذج.
 *   submit   : نص زر الحفظ.
 *   onSubmit : دالة تستلم النموذج. إن رمت خطأ، يظهر نصه أعلى النموذج وتبقى النافذة مفتوحة.
 *              وإن نجحت، تُغلق النافذة.
 * تُحذف النافذة من الصفحة بعد إغلاقها، فلا تتراكم.
 */
export function openDialog({ title, body, submit = "حفظ", danger = false, onSubmit }) {
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.innerHTML = `
    <form novalidate>
      <h2>${esc(title)}</h2>
      <div data-dialog-error></div>
      ${body}
      <div class="modal-actions">
        <button class="btn ${danger ? "btn-danger" : ""}" type="submit">${esc(submit)}</button>
        <button class="btn btn-light" type="button" data-close>إلغاء</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await onSubmit(form);
      dialog.close();
    } catch (err) {
      // خطأ من الـ API (له status) يُترجم إلى العربية، وخطأ الفحص المحلي (userError) يُعرض كما هو.
      const message = err.userMessage ?? (err.status !== undefined ? errorText(err) : err.message);
      dialog.querySelector("[data-dialog-error]").innerHTML = `<div class="alert error">${esc(message)}</div>`;
      button.disabled = false;
    }
  });
  dialog.showModal();
  return dialog;
}

/** خطأ برسالة جاهزة للمستخدم، ترميه دوال onSubmit في النوافذ عند فشل فحص الحقول. */
export function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}
