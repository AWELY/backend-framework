// تفاصيل طلب واحد في لوحة التحكم (admin/order.html?id=...): هنا يدير المدير رحلة الطلب كاملة.
//
//   الحالة   : تأكيد، أو إلغاء، أو شحن، أو تسليم. عبر مسار الإطار PATCH /orders/:id/status،
//              وآلة الحالات في الإطار ترفض أي انتقال غير مسموح (409)، فالأزرار تعرض المسموح فقط.
//   المندوب  : تعيين أو تغيير أو إلغاء (إضافة التوصيل: PUT/DELETE /orders/:id/courier).
//   الدفع    : تسجيل الاستلام أو الاسترجاع (مسار الإطار PATCH /orders/:id/payment).
//   السجل    : كل ما حدث للطلب ومتى (إضافة customer-orders: GET /orders/:id/history).
import {
  requireAdmin, mountAdmin, staffApi, esc, icon, money, formatDate, errorText, toast, qs, showLoadError,
  openDialog, statusChip, shortId, STATUS, PAYMENT, refreshPendingCount,
} from "../common.js";

const id = qs("id");
const session = requireAdmin();
let content;
if (session) {
  content = mountAdmin(session, {
    active: "orders",
    title: "تفاصيل الطلب",
    actions: `<a class="btn btn-sm btn-light" href="orders.html">كل الطلبات</a>`,
  });
  render();
}

/** يحمّل الطلب وكل ما يتعلق به ويرسم الصفحة. يُستدعى من جديد بعد كل إجراء، فتعرض الصفحة رد الخادم. */
function render() {
  load().catch((err) => showLoadError(content, err.status === 404 ? "الطلب غير موجود." : errorText(err)));
}

async function load() {
  if (!id) throw Object.assign(new Error("missing id"), { status: 404 });
  // أربعة طلبات متوازية: الطلب (الإطار)، ومعلومات التوصيل والسجل (إضافتان)، والمندوبون للقائمة.
  const [order, deliveries, history, couriers] = await Promise.all([
    staffApi(`/orders/${encodeURIComponent(id)}`),
    staffApi(`/deliveries?orderIds=${encodeURIComponent(id)}`),
    staffApi(`/orders/${encodeURIComponent(id)}/history`),
    staffApi("/staff?role=courier"),
  ]);
  const delivery = deliveries[0] ?? null;
  const isPickup = order.shippingMethod === "pickup";
  document.querySelector(".admin-top h1").textContent = `طلب ${shortId(order.id)}`;

  content.innerHTML = `
    <div class="cols detail">
      <div class="stack">
        <section class="box">
          <div class="box-head"><h2>الحالة</h2>${statusChip(order.status, STATUS)}</div>
          <div class="box-body">${statusActions(order, delivery)}</div>
        </section>

        <section class="box">
          <div class="box-head"><h2>المنتجات</h2><span class="muted">${formatDate(order.createdAt)}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>المنتج</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead>
            <tbody>
              ${order.items.map((i) => `<tr><td>${esc(i.productName)}${i.productId ? "" : `<span class="sub">حُذف من المتجر</span>`}</td>
                <td class="n">${money(i.unitPrice)}</td><td class="n">${i.quantity}</td><td class="n">${money(i.lineTotal)}</td></tr>`).join("")}
              <tr><td colspan="3">${isPickup ? "استلام من المحل" : `التوصيل إلى ${esc(order.shippingCity ?? "—")}`}</td><td class="n">${order.shippingCost ? money(order.shippingCost) : "مجاناً"}</td></tr>
              <tr><td colspan="3"><b>الإجمالي</b></td><td class="n"><b>${money(order.total)}</b></td></tr>
            </tbody>
          </table></div>
        </section>

        <section class="box">
          <div class="box-head"><h2>الزبون</h2><span class="muted">${order.customerId ? "زبون مسجل" : "ضيف (بلا حساب)"}</span></div>
          <div class="box-body">
            <dl class="dl">
              <dt>الاسم</dt><dd>${esc(order.contactName)}</dd>
              <dt>الهاتف</dt><dd><a class="row-link ltr" href="tel:${esc(order.contactPhone.replace(/[^\d+]/g, ""))}">${esc(order.contactPhone)}</a></dd>
              <dt>الاستلام</dt><dd>${isPickup ? "من المحل في تاجوراء" : `${esc(order.shippingCity ?? "")}، ${esc(order.shippingAddress)}`}</dd>
              <dt>رقم الطلب</dt><dd><span class="order-id">${esc(order.id)}</span></dd>
            </dl>
          </div>
        </section>
      </div>

      <div class="stack">
        ${isPickup ? "" : `
        <section class="box">
          <div class="box-head"><h2>التوصيل</h2>${delivery ? `<span class="muted">${esc(delivery.courierName)}</span>` : ""}</div>
          <div class="box-body">${deliveryPanel(order, delivery, couriers)}</div>
        </section>`}

        <section class="box">
          <div class="box-head"><h2>الدفع</h2>${statusChip(order.paymentStatus, PAYMENT)}</div>
          <div class="box-body">${paymentPanel(order)}</div>
        </section>

        <section class="box">
          <div class="box-head"><h2>سجل الطلب</h2></div>
          <div class="box-body">${history.length ? `<ol class="timeline">${history.map(eventItem).join("")}</ol>`
            : `<p class="muted">أُنشئ الطلب في ${esc(formatDate(order.createdAt))}. (طلب أقدم من سجل الأحداث.)</p>`}</div>
        </section>
      </div>
    </div>`;

  bindActions(order, delivery);
}

/**
 * أزرار الحالة المسموحة فقط، حسب آلة الحالات في الإطار (STATUS_TRANSITIONS):
 *   pending → confirmed أو cancelled، و confirmed → shipped أو cancelled، و shipped → delivered.
 * طلب "الاستلام من المحل" لا يخرج مع مندوب: shipped عنده تعني "جاهز للاستلام".
 */
function statusActions(order, delivery) {
  const isPickup = order.shippingMethod === "pickup";
  const cancel = `<button class="btn btn-danger" data-status="cancelled">إلغاء الطلب</button>`;
  switch (order.status) {
    case "pending":
      return `<p class="muted">اتصل بالزبون للتأكد من الطلب والعنوان، ثم أكّده.</p>
        <div class="action-row"><button class="btn" data-status="confirmed">${icon("check", 18)} تأكيد الطلب</button>${cancel}</div>`;
    case "confirmed":
      if (isPickup) {
        return `<p class="muted">جهّز الطلب، ثم أبلغ الزبون أنه جاهز للاستلام من المحل.</p>
          <div class="action-row"><button class="btn" data-status="shipped">جاهز للاستلام</button>${cancel}</div>`;
      }
      return `<p class="muted">${delivery ? `بانتظار أن يستلمه ${esc(delivery.courierName)} من المحل.` : "عيّن مندوباً من قسم التوصيل."}</p>
        <div class="action-row"><button class="btn btn-outline" data-status="shipped">شُحن بطريقة أخرى</button>${cancel}</div>`;
    case "shipped":
      return `<p class="muted">${isPickup ? "بانتظار أن يستلمه الزبون من المحل." : delivery ? `الطلب مع المندوب ${esc(delivery.courierName)}، وهو يسجّل التسليم من تطبيقه.` : "الطلب في الطريق."}</p>
        <div class="action-row"><button class="btn ${delivery ? "btn-outline" : ""}" data-status="delivered">${isPickup ? "استلمه الزبون" : "تم التسليم"}</button></div>`;
    case "delivered":
      return `<p class="muted">تم تسليم الطلب. لا إجراءات أخرى.</p>`;
    default:
      return `<p class="muted">الطلب ملغي، وأُعيدت كمياته إلى المخزون.</p>`;
  }
}

/** قسم التوصيل: المندوب المعيّن ومراحله، أو قائمة لتعيين مندوب. */
function deliveryPanel(order, delivery, couriers) {
  const active = couriers.filter((c) => c.isActive);
  const options = (selected) =>
    active.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}${c.phone ? ` (${esc(c.phone)})` : ""}</option>`).join("");
  const assignForm = (label) => active.length
    ? `<form class="inline-form" data-assign><select name="courierId" aria-label="المندوب">${options(delivery?.courierId)}</select><button class="btn">${label}</button></form>`
    : `<p class="muted">لا يوجد مندوبون نشطون. <a class="row-link" href="staff.html">أضف مندوباً</a></p>`;

  if (!delivery) {
    if (order.status === "pending") return `<p class="muted">أكّد الطلب أولاً، ثم عيّن له مندوباً.</p>`;
    if (order.status !== "confirmed") return `<p class="muted">لم يُعيَّن مندوب لهذا الطلب.</p>`;
    return assignForm("تعيين");
  }
  const canChange = order.status === "confirmed" && !delivery.pickedUpAt;
  return `
    ${delivery.note ? `<div class="alert warn">${icon("alert", 16)} ملاحظة المندوب: ${esc(delivery.note)}<br><small>${esc(formatDate(delivery.noteAt))}</small></div>` : ""}
    <dl class="dl">
      <dt>المندوب</dt><dd>${esc(delivery.courierName)}${delivery.courierPhone ? `، <a class="row-link ltr" href="tel:${esc(delivery.courierPhone)}">${esc(delivery.courierPhone)}</a>` : ""}</dd>
      <dt>عُيّن</dt><dd>${esc(formatDate(delivery.assignedAt))}</dd>
      <dt>استلم من المحل</dt><dd>${delivery.pickedUpAt ? esc(formatDate(delivery.pickedUpAt)) : "ليس بعد"}</dd>
      <dt>سلّم الطلب</dt><dd>${delivery.deliveredAt ? esc(formatDate(delivery.deliveredAt)) : "ليس بعد"}</dd>
      ${delivery.deliveredAt ? `<dt>حصّل نقداً</dt><dd class="num">${money(delivery.cashCollected ?? 0)}</dd>` : ""}
    </dl>
    ${canChange ? `<p></p>${assignForm("تغيير المندوب")}<div class="action-row"><button class="btn btn-sm btn-light" data-unassign>إلغاء التعيين</button></div>` : ""}`;
}

/** قسم الدفع: الحالة ورقم العملية، وزر لتسجيل الدفع أو الاسترجاع. */
function paymentPanel(order) {
  const method = order.paymentMethod === "cod" ? "نقداً عند الاستلام" : (order.paymentMethod ?? "—");
  const actions = [];
  if (["unpaid", "pending", "failed"].includes(order.paymentStatus) && order.status !== "cancelled") {
    actions.push(`<button class="btn btn-sm btn-success" data-pay="paid">تسجيل استلام المبلغ</button>`);
  }
  if (order.paymentStatus === "paid") actions.push(`<button class="btn btn-sm btn-light" data-pay="refunded">تسجيل استرجاع المبلغ</button>`);
  return `
    <dl class="dl">
      <dt>الطريقة</dt><dd>${esc(method)}</dd>
      <dt>المبلغ</dt><dd class="num">${money(order.total)}</dd>
      ${order.paymentReference ? `<dt>المرجع</dt><dd>${esc(order.paymentReference)}</dd>` : ""}
    </dl>
    ${actions.length ? `<p></p><div class="action-row">${actions.join("")}</div>` : ""}`;
}

/** سطر في سجل الطلب بلغة المدير. */
function eventItem(e) {
  let text;
  let kind = "";
  if (e.kind === "created") text = "أنشأ الزبون الطلب";
  else if (e.kind === "payment") {
    text = `الدفع: ${PAYMENT[e.to] ?? e.to}`;
    if (e.to === "paid") kind = "good";
  } else {
    text = `الحالة: ${STATUS[e.to] ?? e.to}`;
    if (e.to === "delivered") kind = "good";
    if (e.to === "cancelled") kind = "bad";
  }
  return `<li class="${kind}"><b>${esc(text)}</b><time datetime="${esc(e.at)}">${esc(formatDate(e.at))}</time></li>`;
}

/** يربط الأزرار. كل إجراء ناجح يعيد رسم الصفحة من الخادم، ويحدّث عدد الطلبات الجديدة في القائمة. */
function bindActions(order, delivery) {
  const done = (message) => {
    toast(message);
    refreshPendingCount();
    render();
  };
  // ينفّذ طلباً من زر، ويعطّل الزر أثناءه، ويعرض الخطأ بالعربية إن فشل.
  const run = async (button, work, message) => {
    button.disabled = true;
    try {
      await work();
      done(message);
    } catch (err) {
      toast(errorText(err), "error");
      button.disabled = false;
    }
  };

  const LABELS = { confirmed: "تم تأكيد الطلب", shipped: "تم تحديث الطلب", delivered: "تم تسجيل التسليم", cancelled: "تم إلغاء الطلب" };
  content.querySelectorAll("[data-status]").forEach((b) =>
    b.addEventListener("click", () => {
      const status = b.dataset.status;
      if (status === "cancelled" && !confirm("إلغاء الطلب يعيد كمياته إلى المخزون. هل أنت متأكد؟")) return;
      run(b, () => staffApi(`/orders/${order.id}/status`, { method: "PATCH", body: { status } }), LABELS[status]);
    })
  );

  content.querySelector("[data-assign]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const courierId = e.target.courierId.value;
    run(e.target.querySelector("button"), () => staffApi(`/orders/${order.id}/courier`, { method: "PUT", body: { courierId } }), "تم تعيين المندوب");
  });
  content.querySelector("[data-unassign]")?.addEventListener("click", (e) => {
    if (!confirm(`إلغاء تعيين ${delivery.courierName}؟`)) return;
    run(e.currentTarget, () => staffApi(`/orders/${order.id}/courier`, { method: "DELETE" }), "تم إلغاء التعيين");
  });

  // تسجيل الدفع: نافذة تطلب رقماً مرجعياً اختيارياً (مثل "إيصال 1042").
  content.querySelectorAll("[data-pay]").forEach((b) =>
    b.addEventListener("click", () => {
      const status = b.dataset.pay;
      openDialog({
        title: status === "paid" ? "تسجيل استلام المبلغ" : "تسجيل استرجاع المبلغ",
        submit: status === "paid" ? "تسجيل الاستلام" : "تسجيل الاسترجاع",
        body: `<p class="muted">المبلغ: <b class="num">${money(order.total)}</b></p>
          <div class="field"><label for="ref">مرجع (اختياري)</label><input id="ref" name="reference" maxlength="200" placeholder="مثال: إيصال رقم 1042"></div>`,
        onSubmit: async (form) => {
          const reference = form.reference.value.trim();
          await staffApi(`/orders/${order.id}/payment`, { method: "PATCH", body: reference ? { status, reference } : { status } });
          done(status === "paid" ? "تم تسجيل الدفع" : "تم تسجيل الاسترجاع");
        },
      });
    })
  );
}
