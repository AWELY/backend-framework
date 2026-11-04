// صفحة "طلباتي" (orders.html) داخل منطقة الحساب: طلبات الزبون المسجل دخوله فقط، مع سجل كل طلب،
// وزر "إلغاء الطلب" للطلب الذي لم يؤكده المتجر بعد.
// الـ API يصفّي الطلبات برقم الزبون من التوكن نفسه، فلا يستطيع زبون رؤية طلبات غيره.
import { api } from "../api.js";
import { getToken } from "../store.js";
import { mountLayout, esc, errorText, toast } from "../ui.js";
import { orderCard } from "../order-view.js";
import { accountShell } from "../account-shell.js";

mountLayout("account");
const app = document.getElementById("app");

// تصفية القائمة: الجارية (لم تنتهِ بعد) أو المنتهية. الحالات من آلة الحالات في الإطار.
const FILTERS = {
  all: { label: "الكل", match: () => true },
  open: { label: "الجارية", match: (o) => ["pending", "confirmed", "shipped"].includes(o.status) },
  done: { label: "المنتهية", match: (o) => ["delivered", "cancelled"].includes(o.status) },
};

async function load() {
  // غير مسجل: إلى صفحة الدخول، ثم العودة إلى هنا (?next=orders.html).
  if (!getToken()) {
    location.href = "account.html?next=orders.html";
    return;
  }
  // الملف الشخصي (للقائمة الجانبية) والطلبات معاً.
  const [me, orders] = await Promise.all([api("/customers/me"), api("/orders")]);
  // سجل كل طلب من إضافة customer-orders، بطلبات متوازية. فشل سجل واحد لا يوقف الصفحة: null.
  const histories = new Map(
    await Promise.all(orders.map(async (o) => [o.id, await api(`/orders/${o.id}/history`).catch(() => null)]))
  );

  const content = accountShell(app, "orders", me, "طلباتي");
  if (orders.length === 0) {
    content.innerHTML = `<div class="panel empty"><div class="big">لا توجد طلبات بعد</div>
      <p>عندما تطلب من المتجر وأنت مسجل الدخول، تظهر طلباتك هنا مع كل مراحلها.</p><a class="btn" href="index.html">ابدأ التسوق</a></div>`;
    return;
  }

  /** يرسم القائمة حسب التصفية المختارة. إلغاء طلب يعيد تحميل الصفحة كلها من الـ API. */
  const render = (filter) => {
    const shown = orders.filter(FILTERS[filter].match);
    content.innerHTML = `
      <div class="chips" role="tablist" aria-label="تصفية الطلبات">${Object.entries(FILTERS).map(([key, f]) =>
        `<button type="button" class="chip ${key === filter ? "active" : ""}" data-filter="${key}">${f.label} (${orders.filter(f.match).length})</button>`).join("")}
      </div>
      <p></p>
      ${shown.length
        ? shown.map((o) => orderCard(o, {
            history: histories.get(o.id),
            // الإلغاء متاح فقط قبل أن يؤكد المتجر الطلب (القاعدة نفسها يفرضها الخادم).
            actions: o.status === "pending" ? `<button class="btn btn-danger btn-sm" data-cancel="${esc(o.id)}">إلغاء الطلب</button>` : "",
          })).join("")
        : `<div class="panel empty"><div class="big">لا توجد طلبات هنا</div></div>`}`;
    content.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => render(b.dataset.filter)));
    content.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => cancel(b)));
  };

  render("all");
}

/** يلغي طلباً بعد تأكيد الزبون. الخادم يعيد كميات الطلب إلى المخزون تلقائياً (خدمة الطلبات في الإطار). */
async function cancel(button) {
  if (!confirm("هل تريد إلغاء هذا الطلب؟")) return;
  button.disabled = true;
  try {
    await api(`/orders/${encodeURIComponent(button.dataset.cancel)}/cancel`, { method: "POST" });
    toast("تم إلغاء الطلب");
    await load();
  } catch (err) {
    toast(errorText(err), "error");
    button.disabled = false;
  }
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل الطلبات</div><p>${esc(errorText(err))}</p></div>`;
});
