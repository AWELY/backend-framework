import { esc, money, errorText, toast, formatDate, icon, DELIVERY_STATUS } from "../ui.js";
import { identity, can, renderLogin, topBar, sapi, sapiPage, isSessionError, modal, pill, showMessage, toDirhams, toDinars, logout, ROLE_LABELS } from "./common.js";
import { ordersView, openOrder, statusPill, paymentPill } from "./admin-orders.js";
import { productsView, categoriesView } from "./admin-catalog.js";

/**
 * لوحة الإدارة: تطبيق صفحة واحدة بروابط (#/orders، #/products...).
 * كل قسم يظهر فقط لمن يملك صلاحيته (can)، والخادم يفرضها في كل طلب.
 * الدخول: حساب موظف (مدير، مشرف، خدمة عملاء)، أو مفتاح المالك لإدارة الموظفين.
 */
const app = document.getElementById("app");

const SECTIONS = [
  { path: "", label: "البداية", icon: "grid", permission: "orders:read-all", view: dashboardView },
  { path: "orders", label: "الطلبات", icon: "package", permission: "orders:read-all", view: ordersView },
  { path: "deliveries", label: "التوصيل", icon: "truck", permission: "deliveries:read-all", view: deliveriesView },
  { path: "products", label: "المنتجات", icon: "store", permission: "products:read", view: productsView },
  { path: "categories", label: "الأقسام", icon: "grid", permission: "categories:read", view: categoriesView },
  { path: "coupons", label: "الكوبونات", icon: "gift", permission: "coupons:read", view: couponsView },
  { path: "customers", label: "الزبائن", icon: "user", permission: "customers:read", view: customersView },
  { path: "staff", label: "الموظفون", icon: "shield", permission: "staff:read", view: staffView },
  { path: "audit", label: "سجل التدقيق", icon: "clock", permission: "audit:read", view: auditView },
];

function start() {
  if (!identity()) {
    app.className = "staff-main";
    renderLogin(app, { title: "لوحة الإدارة", allowOwner: true, allowedRoles: ["admin", "manager", "support"], onSuccess: () => location.reload() });
    return;
  }
  document.body.prepend(topBar("لوحة الإدارة"));
  const visible = SECTIONS.filter((s) => can(s.permission));
  app.innerHTML = `<div class="staff-shell"><nav class="staff-nav" data-nav>${visible
    .map((s) => `<a href="#/${s.path}" data-path="${s.path}">${icon(s.icon, 18)} ${esc(s.label)}</a>`)
    .join("")}</nav><section class="staff-main" data-view></section></div>`;
  window.addEventListener("hashchange", route);
  route();
}

async function route() {
  // الانتقال لقسم آخر يغلق أي نافذة مفتوحة من القسم السابق.
  document.querySelectorAll("dialog.modal").forEach((d) => d.remove());
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const visible = SECTIONS.filter((s) => can(s.permission));
  const section = visible.find((s) => s.path === path) ?? visible[0];
  document.querySelectorAll("[data-nav] a").forEach((a) => a.classList.toggle("active", a.dataset.path === section?.path));
  const view = app.querySelector("[data-view]");
  if (!section) {
    view.innerHTML = `<div class="alert error">لا توجد أقسام لدورك.</div>`;
    return;
  }
  view.innerHTML = `<div class="loading">جاري التحميل...</div>`;
  try {
    await section.view(view, new URLSearchParams(query));
  } catch (err) {
    if (isSessionError(err)) return logout();
    view.innerHTML = `<div class="alert error">${esc(errorText(err))}</div>`;
  }
}

/** البداية: أرقام سريعة من X-Total-Count (طلب بحد 1 لكل رقم)، وآخر الطلبات. */
async function dashboardView(root) {
  const count = async (path) => (await sapiPage(`${path}${path.includes("?") ? "&" : "?"}limit=1`)).total;
  const [pending, confirmed, shipped, unpaidCard, failedDeliveries, recent] = await Promise.all([
    count("/orders?status=pending"),
    count("/orders?status=confirmed"),
    count("/orders?status=shipped"),
    count("/orders?paymentStatus=failed"),
    can("deliveries:read-all") ? count("/deliveries?status=failed") : Promise.resolve(0),
    sapiPage("/orders?limit=8"),
  ]);
  root.innerHTML = `
    <h1>البداية</h1>
    <div class="kpis">
      <a class="kpi warn" href="#/orders?status=pending"><div class="value">${pending}</div><div class="label">طلبات تنتظر التأكيد</div></a>
      <a class="kpi" href="#/orders?status=confirmed"><div class="value">${confirmed}</div><div class="label">مؤكدة، تنتظر المندوب</div></a>
      <a class="kpi" href="#/orders?status=shipped"><div class="value">${shipped}</div><div class="label">في الطريق</div></a>
      <a class="kpi ${unpaidCard ? "warn" : ""}" href="#/orders?payment=failed"><div class="value">${unpaidCard}</div><div class="label">فشل دفعها</div></a>
      <a class="kpi ${failedDeliveries ? "warn" : ""}" href="#/deliveries"><div class="value">${failedDeliveries}</div><div class="label">توصيلات لم تنجح</div></a>
      <div class="kpi"><div class="value">${recent.total}</div><div class="label">كل الطلبات</div></div>
    </div>
    <h2>آخر الطلبات</h2>
    <div class="table-wrap"><table class="data"><thead><tr><th>الطلب</th><th>الزبون</th><th>الإجمالي</th><th>الحالة</th><th>الدفع</th></tr></thead><tbody>
      ${recent.items.map((o) => `<tr class="clickable" data-open="${esc(o.id)}"><td class="ltr">${esc(o.id.slice(0, 8))}</td><td>${esc(o.contactName)}</td><td class="num">${money(o.total)}</td><td>${statusPill(o.status)}</td><td>${paymentPill(o.paymentStatus)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty-row">لا طلبات بعد</td></tr>`}
    </tbody></table></div>`;
  root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => openOrder(r.dataset.open, () => dashboardView(root))));
}

/** التوصيل: كل التوصيلات، بالحالة وبالمندوب. */
async function deliveriesView(root) {
  const state = { status: "" };
  root.innerHTML = `
    <h1>التوصيل</h1>
    <div class="toolbar"><select data-status><option value="">كل الحالات</option>${Object.entries(DELIVERY_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <span class="spacer"></span><span class="muted" data-count></span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الطلب</th><th>الزبون</th><th>المدينة</th><th>المندوب</th><th>الحالة</th><th>المبلغ</th><th>آخر تحديث</th></tr></thead><tbody data-rows></tbody></table></div>`;
  async function load() {
    const { items, total } = await sapiPage(`/deliveries?limit=100${state.status ? `&status=${state.status}` : ""}`);
    root.querySelector("[data-count]").textContent = `${total} توصيل`;
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((d) => `<tr class="clickable" data-open="${esc(d.orderId)}"><td class="ltr">${esc(d.orderId.slice(0, 8))}</td><td>${esc(d.order.contactName)}</td><td>${esc(d.order.shippingCity ?? "—")}</td>
          <td>${esc(d.courierName ?? "—")}</td><td>${pill(DELIVERY_STATUS[d.status], { assigned: "blue", picked_up: "amber", delivered: "green", failed: "red" }[d.status])}${d.note ? `<br><span class="muted">${esc(d.note)}</span>` : ""}</td>
          <td class="num">${money(d.order.total)}</td><td>${esc(formatDate(d.updatedAt))}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty-row">لا توصيلات</td></tr>`;
    root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => openOrder(r.dataset.open, load)));
  }
  root.querySelector("[data-status]").addEventListener("change", (e) => ((state.status = e.target.value), load()));
  await load();
}

/** الكوبونات (إضافة coupons من الإطار). */
async function couponsView(root) {
  const writable = can("coupons:write");
  root.innerHTML = `
    <h1>الكوبونات</h1>
    <div class="toolbar"><span class="spacer"></span>${writable ? `<button class="btn" data-new>كوبون جديد</button>` : ""}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الرمز</th><th>الخصم</th><th>الحد الأدنى</th><th>الاستخدام</th><th>ينتهي</th><th>الحالة</th><th></th></tr></thead><tbody data-rows></tbody></table></div>`;
  async function load() {
    const { items } = await sapiPage("/coupons?limit=100");
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((c) => `<tr><td class="ltr"><b>${esc(c.code)}</b></td><td>${c.kind === "percent" ? `${c.value}%` : money(c.value)}</td><td class="num">${c.minSubtotal ? money(c.minSubtotal) : "—"}</td>
          <td>${c.redeemedCount}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}</td><td>${c.expiresAt ? esc(formatDate(c.expiresAt)) : "—"}</td>
          <td>${c.isActive ? pill("فعّال", "green") : pill("موقوف")}</td>
          <td>${writable ? `<button class="link-btn" data-toggle="${esc(c.code)}" data-active="${c.isActive}">${c.isActive ? "إيقاف" : "تفعيل"}</button> <button class="link-btn" data-delete="${esc(c.code)}">حذف</button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty-row">لا كوبونات</td></tr>`;
    root.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await sapi(`/coupons/${b.dataset.toggle}`, { method: "PATCH", body: { isActive: b.dataset.active !== "true" } });
        load();
      } catch (err) {
        toast(errorText(err), "error");
      }
    }));
    root.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(`حذف الكوبون ${b.dataset.delete}؟`)) return;
      try {
        await sapi(`/coupons/${b.dataset.delete}`, { method: "DELETE" });
        load();
      } catch (err) {
        toast(errorText(err), "error");
      }
    }));
  }
  root.querySelector("[data-new]")?.addEventListener("click", () => {
    const { el, close } = modal("كوبون جديد", `
      <div data-msg></div>
      <form novalidate><div class="form-grid">
        <div class="field"><label>الرمز</label><input name="code" class="ltr" required placeholder="RAMADAN15"></div>
        <div class="field"><label>النوع</label><select name="kind"><option value="percent">نسبة مئوية</option><option value="fixed">مبلغ ثابت (دينار)</option></select></div>
        <div class="field"><label>القيمة</label><input name="value" type="number" step="0.001" min="0.001" class="ltr" required></div>
        <div class="field"><label>حد أدنى للمشتريات (دينار، اختياري)</label><input name="minSubtotal" type="number" step="0.001" min="0" class="ltr"></div>
        <div class="field"><label>أقصى عدد استخدامات (اختياري)</label><input name="maxRedemptions" type="number" min="1" class="ltr"></div>
        <div class="field"><label>ينتهي في (اختياري)</label><input name="expiresAt" type="date" class="ltr"></div>
      </div><button class="btn">إنشاء</button></form>`);
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const body = {
        code: f.code.value.trim(),
        kind: f.kind.value,
        value: f.kind.value === "percent" ? Math.round(Number(f.value.value)) : toDirhams(f.value.value),
        ...(f.minSubtotal.value ? { minSubtotal: toDirhams(f.minSubtotal.value) } : {}),
        ...(f.maxRedemptions.value ? { maxRedemptions: Number(f.maxRedemptions.value) } : {}),
        ...(f.expiresAt.value ? { expiresAt: new Date(`${f.expiresAt.value}T23:59:59`).toISOString() } : {}),
      };
      try {
        await sapi("/coupons", { method: "POST", body });
        toast("تم إنشاء الكوبون");
        close();
        load();
      } catch (err) {
        showMessage(el, errorText(err));
      }
    });
  });
  await load();
}

/** الزبائن: بحث في البريد والاسم والهاتف. */
async function customersView(root) {
  const state = { q: "" };
  root.innerHTML = `
    <h1>الزبائن</h1>
    <div class="toolbar"><input type="search" placeholder="بحث: البريد، الاسم، الهاتف" data-q><span class="spacer"></span><span class="muted" data-count></span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الاسم</th><th>البريد</th><th>الهاتف</th><th>التسجيل</th></tr></thead><tbody data-rows></tbody></table></div>`;
  async function load() {
    const { items, total } = await sapiPage(`/customers?limit=50${state.q ? `&q=${encodeURIComponent(state.q)}` : ""}`);
    root.querySelector("[data-count]").textContent = `${total} زبون`;
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((c) => `<tr><td>${esc(c.name)}</td><td class="ltr">${esc(c.email)}</td><td class="ltr">${esc(c.phone ?? "—")}</td><td>${esc(formatDate(c.createdAt))}</td></tr>`).join("")
      : `<tr><td colspan="4" class="empty-row">لا نتائج</td></tr>`;
  }
  let timer;
  root.querySelector("[data-q]").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => ((state.q = e.target.value.trim()), load()), 300);
  });
  await load();
}

/** الموظفون: الكل يقرأ (staff:read)، والمالك وحده ينشئ ويعدّل (staff:write). */
async function staffView(root) {
  const writable = can("staff:write");
  const roles = await sapi("/staff/roles");
  root.innerHTML = `
    <h1>الموظفون</h1>
    ${writable ? "" : `<p class="muted">إدارة الحسابات للمالك فقط (ادخل بمفتاح المالك).</p>`}
    <div class="toolbar"><select data-role><option value="">كل الأدوار</option>${roles.map((r) => `<option value="${r}">${esc(ROLE_LABELS[r] ?? r)}</option>`).join("")}</select>
      <span class="spacer"></span>${writable ? `<button class="btn" data-new>موظف جديد</button>` : ""}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الاسم</th><th>البريد</th><th>الهاتف</th><th>الدور</th><th>الحالة</th></tr></thead><tbody data-rows></tbody></table></div>`;
  async function load(role = "") {
    const { items } = await sapiPage(`/staff?limit=100${role ? `&role=${role}` : ""}`);
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((s) => `<tr class="${writable ? "clickable" : ""}" data-open="${esc(s.id)}"><td>${esc(s.name)}</td><td class="ltr">${esc(s.email)}</td><td class="ltr">${esc(s.phone ?? "—")}</td>
          <td>${pill(ROLE_LABELS[s.role] ?? s.role, "blue")}</td><td>${s.isActive ? pill("نشط", "green") : pill("موقوف", "red")}</td></tr>`).join("")
      : `<tr><td colspan="5" class="empty-row">لا موظفين</td></tr>`;
    if (writable) root.querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => editStaff(items.find((s) => s.id === r.dataset.open), roles, () => load(role))));
  }
  root.querySelector("[data-role]").addEventListener("change", (e) => load(e.target.value));
  root.querySelector("[data-new]")?.addEventListener("click", () => editStaff(null, roles, () => load()));
  await load();
}

function editStaff(member, roles, onChange) {
  const { el, close } = modal(member ? "تعديل موظف" : "موظف جديد", `
    <div data-msg></div>
    <form novalidate><div class="form-grid">
      <div class="field"><label>الاسم</label><input name="name" value="${esc(member?.name ?? "")}" required></div>
      ${member ? "" : `<div class="field"><label>البريد</label><input name="email" type="email" class="ltr" required></div>`}
      <div class="field"><label>الهاتف</label><input name="phone" type="tel" class="ltr" value="${esc(member?.phone ?? "")}"></div>
      <div class="field"><label>الدور</label><select name="role">${roles.map((r) => `<option value="${r}" ${r === member?.role ? "selected" : ""}>${esc(ROLE_LABELS[r] ?? r)}</option>`).join("")}</select></div>
      <div class="field"><label>${member ? "كلمة مرور جديدة (اختياري)" : "كلمة المرور"}</label><input name="password" type="password" autocomplete="new-password" minlength="8"></div>
      ${member ? `<label class="check-line"><input type="checkbox" name="isActive" ${member.isActive ? "checked" : ""}> الحساب نشط</label>` : ""}
    </div>
    <p class="muted">تغيير الدور أو كلمة المرور أو إيقاف الحساب يُخرج الموظف من كل أجهزته فوراً.</p>
    <button class="btn">حفظ</button></form>`);
  el.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      if (member) {
        const body = { name: f.name.value.trim(), phone: f.phone.value.trim() || null, isActive: f.isActive.checked };
        if (f.role.value !== member.role) body.role = f.role.value;
        if (f.password.value) body.password = f.password.value;
        await sapi(`/staff/${member.id}`, { method: "PATCH", body });
      } else {
        await sapi("/staff", {
          method: "POST",
          body: { name: f.name.value.trim(), email: f.email.value.trim(), role: f.role.value, password: f.password.value, ...(f.phone.value.trim() ? { phone: f.phone.value.trim() } : {}) },
        });
      }
      toast("تم الحفظ");
      close();
      onChange();
    } catch (err) {
      showMessage(el, errorText(err));
    }
  });
}

/** سجل التدقيق: كل كتابة من المالك أو موظف، ومحاولات دخول الموظفين. */
async function auditView(root) {
  const state = { action: "", page: 1 };
  root.innerHTML = `
    <h1>سجل التدقيق</h1>
    <div class="toolbar"><input placeholder="العملية تبدأ بـ (مثل: PATCH /orders)" data-action class="ltr"><span class="spacer"></span><span class="muted" data-count></span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>الوقت</th><th>الفاعل</th><th>العملية</th><th>النتيجة</th><th>IP</th><th>رقم الطلب</th></tr></thead><tbody data-rows></tbody></table></div>
    <div class="pager" data-pager></div>`;
  async function load() {
    const { items, total } = await sapiPage(`/audit-log?limit=50&offset=${(state.page - 1) * 50}${state.action ? `&action=${encodeURIComponent(state.action)}` : ""}`);
    root.querySelector("[data-count]").textContent = `${total} سطر`;
    root.querySelector("[data-rows]").innerHTML = items.length
      ? items.map((a) => `<tr><td>${esc(formatDate(a.at))}</td><td>${esc(ROLE_LABELS[a.actorRole] ?? a.actorRole)} <span class="muted ltr">${esc((a.actorId ?? a.actorType).slice(0, 8))}</span></td>
          <td class="ltr">${esc(a.action)}</td><td>${pill(String(a.statusCode), a.statusCode < 300 ? "green" : a.statusCode < 500 ? "amber" : "red")}</td><td class="ltr">${esc(a.ip ?? "")}</td><td class="ltr muted">${esc((a.requestId ?? "").slice(0, 8))}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty-row">لا شيء بعد</td></tr>`;
    const pages = Math.ceil(total / 50);
    root.querySelector("[data-pager]").innerHTML = pages > 1
      ? `${state.page > 1 ? `<a href="#" data-go="${state.page - 1}">السابق</a>` : ""}<span>صفحة ${state.page} من ${pages}</span>${state.page < pages ? `<a href="#" data-go="${state.page + 1}">التالي</a>` : ""}`
      : "";
    root.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => ((e.preventDefault(), (state.page = Number(a.dataset.go))), load())));
  }
  let timer;
  root.querySelector("[data-action]").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => ((state.action = e.target.value.trim()), (state.page = 1), load()), 300);
  });
  await load();
}

start();
