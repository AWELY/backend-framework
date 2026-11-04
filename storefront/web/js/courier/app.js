// تطبيق مندوب التوصيل (courier/index.html): صفحة واحدة للهاتف.
//
//   1. الدخول بالبريد وكلمة المرور (نفس دخول الموظفين: POST /staff/login).
//   2. "المهام": الطلبات المعيّنة له الآن. لكل طلب: الاسم، وزر اتصال، والعنوان (مع رابط الخرائط)،
//      والمنتجات، والمبلغ المطلوب تحصيله بخط كبير.
//   3. الأزرار حسب المرحلة: "استلمت الطلب من المحل" ثم "تم التسليم"، و"إبلاغ عن مشكلة" دائماً.
//   4. "المنتهية": ما سلّمه (أو أُلغي بعد تعيينه)، ومجموع ما حصّله اليوم.
//
// كل البيانات من إضافة التوصيل (storefront/api/plugins/delivery.js). الخادم يرى المندوب طلباته هو
// فقط، ويرفض أي انتقال غير مسموح (مثل التسليم قبل الاستلام)، فالتطبيق يعرض الأزرار المسموحة فقط.
import { staffApi, staffLogin, setStaffExpiredHandler } from "../api.js";
import { getStaffSession, saveStaffSession, clearStaffSession } from "../store.js";
import { esc, icon, money, formatDate, errorText, toast } from "../ui.js";
import { STORE } from "../config.js";

const app = document.getElementById("app");
// التبويب الحالي: "active" (المهام) أو "done" (المنتهية).
let tab = "active";
// مؤقت التحديث التلقائي.
let timer;

// أسباب جاهزة لزر "إبلاغ عن مشكلة"، فيبلغ المندوب بلمسة واحدة وهو في الطريق.
const REASONS = ["الزبون لا يرد على الهاتف", "العنوان غير واضح", "الزبون طلب التأجيل", "الزبون رفض الاستلام"];

// انتهت الجلسة أو أُوقف الحساب (401 من الخادم): نعرض شاشة الدخول برسالة.
setStaffExpiredHandler(() => renderLogin("انتهت جلستك أو أُوقف حسابك. سجّل الدخول من جديد."));

start();

function start() {
  const session = getStaffSession();
  if (!session) return renderLogin();
  // حساب مدير فتح تطبيق المندوب: مكانه لوحة التحكم.
  if (session.staff.role !== "courier") {
    location.replace("../admin/index.html");
    return;
  }
  renderApp(session);
}

/** شاشة الدخول. message: تنبيه اختياري أعلاها (مثل انتهاء الجلسة). */
function renderLogin(message) {
  clearInterval(timer);
  app.innerHTML = `
    <main class="auth-page">
      <div class="auth-card">
        <div class="brand"><img src="../images/logo.svg" alt="${esc(STORE.name)}"><span>تطبيق المندوب</span></div>
        <h1>أهلاً بك</h1>
        <p>ادخل بالبريد وكلمة المرور التي أعطاك إياها مدير المتجر.</p>
        ${message ? `<div class="alert warn">${esc(message)}</div>` : ""}
        <div data-error></div>
        <form novalidate data-login>
          <div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" class="ltr" autocomplete="username" required></div>
          <div class="field"><label for="password">كلمة المرور</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn-lg btn-block">دخول</button>
        </form>
      </div>
    </main>`;
  const form = app.querySelector("[data-login]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorBox = app.querySelector("[data-error]");
    errorBox.innerHTML = "";
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const { staff, token } = await staffLogin(form.email.value.trim(), form.password.value);
      saveStaffSession(token, staff);
      start();
    } catch (err) {
      errorBox.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
      button.disabled = false;
    }
  });
}

/** هيكل التطبيق: الرأس بملخص اليوم، والقائمة، وشريط التبويبات السفلي. */
function renderApp(session) {
  app.innerHTML = `
    <div class="courier">
      <header class="c-top">
        <div class="row">
          <img src="../images/logo-light.svg" alt="${esc(STORE.name)}">
          <div class="who"><span>${esc(session.staff.name)}</span>
            <button type="button" aria-label="تسجيل الخروج" data-logout>${icon("logout", 20)}</button></div>
        </div>
        <div class="c-stats" data-stats aria-live="polite">
          <div><b>—</b><span>طلبات معك</span></div><div><b>—</b><span>للتحصيل</span></div><div><b>—</b><span>سلّمت اليوم</span></div>
        </div>
      </header>
      <main class="c-list" data-list><div class="loading">جاري التحميل...</div></main>
      <nav class="c-tabs" aria-label="التبويبات">
        <button type="button" data-tab="active">${icon("bike", 22)} المهام</button>
        <button type="button" data-tab="done">${icon("checkCircle", 22)} المنتهية</button>
        <button type="button" data-refresh>${icon("refresh", 22)} تحديث</button>
      </nav>
    </div>`;

  app.querySelectorAll("[data-refresh]").forEach((b) => b.addEventListener("click", () => refresh(true)));
  app.querySelector("[data-logout]").addEventListener("click", () => {
    if (!confirm("تسجيل الخروج من التطبيق؟")) return;
    clearStaffSession();
    renderLogin();
  });
  app.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      refresh();
    })
  );
  refresh();
  // تحديث تلقائي كل دقيقة: إن عيّن المدير طلباً جديداً، يظهر دون أن يضغط المندوب شيئاً.
  clearInterval(timer);
  timer = setInterval(() => refresh(), 60_000);
}

/**
 * يحمّل القائمتين معاً (الجارية والمنتهية): الأرقام في الرأس تحتاج الاثنتين، والقائمة تعرض
 * التبويب المختار. announce: إشعار صغير بعد التحديث اليدوي.
 */
async function refresh(announce = false) {
  const list = app.querySelector("[data-list]");
  if (!list) return;
  app.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  try {
    const [active, done] = await Promise.all([
      staffApi("/courier/deliveries?scope=active"),
      staffApi("/courier/deliveries?scope=done"),
    ]);
    renderStats(active, done);
    list.innerHTML = tab === "active" ? activeList(active) : doneList(done);
    bindCards(list, active);
    if (announce) toast("تم التحديث");
  } catch (err) {
    // 401 تعالجه setStaffExpiredHandler (شاشة الدخول). غير ذلك: رسالة مع إمكانية إعادة المحاولة.
    if (err.status !== 401) list.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
  }
}

/** هل حدث هذا الوقت اليوم (بتوقيت جهاز المندوب)؟ */
const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

function renderStats(active, done) {
  const toCollect = active.reduce((sum, d) => sum + d.amountToCollect, 0);
  const deliveredToday = done.filter((d) => d.status === "delivered" && isToday(d.deliveredAt));
  app.querySelector("[data-stats]").innerHTML = `
    <div><b>${active.length}</b><span>طلبات معك</span></div>
    <div><b>${esc(money(toCollect))}</b><span>للتحصيل</span></div>
    <div><b>${deliveredToday.length}</b><span>سلّمت اليوم</span></div>`;
}

/** المهام الجارية: الطلبات التي بانتظار الاستلام من المحل أولاً، ثم التي في الطريق. */
function activeList(active) {
  if (!active.length) {
    return `<div class="empty"><span class="empty-icon">${icon("bike", 40)}</span><div class="big">لا طلبات معك الآن</div>
      <p>عندما يعيّن لك المدير طلباً يظهر هنا. القائمة تتحدث وحدها كل دقيقة.</p></div>`;
  }
  return active.map(card).join("");
}

/** بطاقة طلب للمندوب. كل نص من الـ API يمر عبر esc. */
function card(d) {
  const waiting = d.status === "confirmed";
  const phone = d.contactPhone.replace(/[^\d+]/g, "");
  // رابط بحث في خرائط Google بالعنوان والمدينة (الموقع لا يخزن إحداثيات).
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.shippingAddress}، ${d.shippingCity ?? ""}، ليبيا`)}`;
  return `
    <article class="c-card" data-order="${esc(d.orderId)}">
      <div class="c-head">
        <span class="status ${waiting ? "confirmed" : "shipped"}">${waiting ? "استلمه من المحل" : "في الطريق إلى الزبون"}</span>
        <span class="order-id">${esc(d.orderId.slice(0, 8))}</span>
      </div>
      <div class="c-body">
        <p class="c-name">${esc(d.contactName)}</p>
        <div class="c-addr">${icon("pin", 18)}<span>${esc(d.shippingCity ?? "")}، ${esc(d.shippingAddress)}</span></div>
        <ul class="c-items">${d.items.map((i) => `<li>${esc(i.productName)} × ${i.quantity}</li>`).join("")}</ul>
        ${d.amountToCollect > 0
          ? `<div class="c-cash"><span>حصّل من الزبون</span><b>${esc(money(d.amountToCollect))}</b></div>`
          : `<div class="c-cash paid"><span>مدفوع مسبقاً، لا تحصّل شيئاً</span><b>${icon("check", 22)}</b></div>`}
        ${d.note ? `<div class="c-note">${icon("alert", 16)}<span>أبلغت: ${esc(d.note)}</span></div>` : ""}
        <div class="c-actions">
          <a class="btn btn-dark" href="tel:${esc(phone)}">${icon("phone", 18)} اتصال</a>
          <a class="btn btn-outline" href="${esc(maps)}" target="_blank" rel="noopener">${icon("pin", 18)} الخريطة</a>
          ${waiting
            ? `<button class="btn btn-lg wide" data-pickup>${icon("package", 20)} استلمت الطلب من المحل</button>`
            : `<button class="btn btn-lg btn-success wide" data-deliver>${icon("checkCircle", 20)} تم التسليم${d.amountToCollect ? ` واستلمت ${esc(money(d.amountToCollect))}` : ""}</button>`}
          <button class="btn btn-light wide" data-note>${icon("note", 18)} إبلاغ عن مشكلة</button>
        </div>
      </div>
    </article>`;
}

/** الطلبات المنتهية، ومجموع ما حصّله اليوم أعلاها. */
function doneList(done) {
  if (!done.length) return `<div class="empty"><div class="big">لا طلبات منتهية بعد</div></div>`;
  const cashToday = done.filter((d) => isToday(d.deliveredAt)).reduce((sum, d) => sum + (d.cashCollected ?? 0), 0);
  return `
    <div class="c-cash"><span>حصّلت اليوم، سلّمه للمحل</span><b>${esc(money(cashToday))}</b></div>
    ${done.map((d) => `
      <article class="c-card">
        <div class="c-head">
          <span class="status ${d.status}">${d.status === "delivered" ? "تم التسليم" : "أُلغي"}</span>
          <span class="muted">${d.deliveredAt ? esc(formatDate(d.deliveredAt)) : ""}</span>
        </div>
        <div class="c-body">
          <p class="c-name">${esc(d.contactName)}</p>
          <div class="c-addr">${icon("pin", 18)}<span>${esc(d.shippingCity ?? "")}، ${esc(d.shippingAddress)}</span></div>
          ${d.status === "delivered" ? `<div class="muted">حصّلت: <b class="num">${esc(money(d.cashCollected ?? 0))}</b></div>` : ""}
        </div>
      </article>`).join("")}`;
}

/** يربط أزرار البطاقات. بعد كل إجراء ناجح نعيد تحميل القائمة من الخادم. */
function bindCards(list, active) {
  list.querySelectorAll(".c-card[data-order]").forEach((cardEl) => {
    const orderId = cardEl.dataset.order;
    const delivery = active.find((d) => d.orderId === orderId);
    const post = async (button, path, body, message) => {
      button.disabled = true;
      try {
        await staffApi(`/courier/deliveries/${orderId}/${path}`, { method: "POST", body });
        toast(message);
        refresh();
      } catch (err) {
        toast(errorText(err), "error");
        button.disabled = false;
      }
    };

    cardEl.querySelector("[data-pickup]")?.addEventListener("click", (e) =>
      post(e.currentTarget, "pickup", undefined, "سُجّل الاستلام. الطلب الآن في الطريق."));

    // التسليم نهائي (يغيّر حالة الطلب والدفع)، فنطلب تأكيداً يذكر المبلغ.
    cardEl.querySelector("[data-deliver]")?.addEventListener("click", (e) => {
      const button = e.currentTarget;
      const cash = delivery.amountToCollect ? ` واستلمت ${money(delivery.amountToCollect)} نقداً` : "";
      if (!confirm(`تأكيد: سلّمت الطلب إلى ${delivery.contactName}${cash}؟`)) return;
      post(button, "deliver", undefined, "تم تسجيل التسليم. شكراً لك!");
    });

    // الإبلاغ عن مشكلة: أسباب جاهزة بلمسة، أو نص يكتبه المندوب.
    cardEl.querySelector("[data-note]")?.addEventListener("click", (e) => {
      const button = e.currentTarget;
      const box = document.createElement("form");
      box.className = "panel";
      box.innerHTML = `
        <div class="reasons">${REASONS.map((r) => `<button type="button" class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join("")}</div>
        <div class="field"><label for="note-${esc(orderId)}">أو اكتب الملاحظة</label><textarea id="note-${esc(orderId)}" name="note" rows="2" maxlength="500"></textarea></div>
        <div class="action-row"><button class="btn">إرسال للمدير</button><button type="button" class="btn btn-light" data-cancel>إلغاء</button></div>`;
      button.replaceWith(box);
      box.querySelectorAll("[data-reason]").forEach((r) => r.addEventListener("click", () => { box.note.value = r.dataset.reason; }));
      box.querySelector("[data-cancel]").addEventListener("click", () => refresh());
      box.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const note = box.note.value.trim();
        if (note.length < 2) return toast("اكتب الملاحظة أو اختر سبباً", "error");
        post(box.querySelector("button:not([type])"), "note", { note }, "وصلت ملاحظتك للمدير");
      });
    });
  });
}
