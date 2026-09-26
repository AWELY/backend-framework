import { api, getExistingCart, ApiError } from "../api.js";
import { getToken, setCartId } from "../store.js";
import { mountLayout, esc, money, errorText, refreshCartBadge } from "../ui.js";

mountLayout("checkout");
const app = document.getElementById("app");

// Same rule as the API (customers.schema PHONE); checked here first for instant feedback.
const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;
const PICKUP_ADDRESS = "استلام من المحل - تاجوراء";
// /checkout/quote needs an address, but prices by city only - this stands in until the buyer types one.
const QUOTE_ADDRESS = "لحساب سعر التوصيل";

async function load() {
  const cart = await getExistingCart();
  if (!cart || cart.items.length === 0) {
    app.innerHTML = `<div class="panel empty"><div class="big">سلتك فارغة</div><a class="btn" href="index.html">تسوّق الآن</a></div>`;
    return;
  }
  if (cart.items.some((i) => !i.available)) {
    location.href = "cart.html";
    return;
  }

  const [options, me] = await Promise.all([
    api("/checkout/options"),
    getToken() ? api("/customers/me").catch(() => null) : Promise.resolve(null),
  ]);
  const methods = options.shippingMethods;
  const payments = options.paymentMethods;

  app.innerHTML = `
    <h1 class="page-title">إتمام الطلب</h1>
    <div class="layout-2">
      <form class="panel" novalidate data-form>
        ${me ? "" : `<div class="alert info">تشتري كضيف. <a href="account.html?next=checkout.html"><u>سجّل الدخول</u></a> لتتابع طلباتك من حسابك (اختياري).</div>`}
        <div data-form-error></div>
        <h3>بيانات المستلم</h3>
        <div class="field"><label for="name">الاسم الكامل</label>
          <input id="name" name="contactName" autocomplete="name" value="${esc(me?.name ?? "")}" required><div class="error"></div></div>
        <div class="field"><label for="phone">رقم الهاتف</label>
          <input id="phone" name="contactPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="09XXXXXXXX" class="ltr" value="${esc(me?.phone ?? "")}" required><div class="error"></div></div>

        <h3>طريقة الاستلام</h3>
        <div class="options">
          ${methods.map((m, i) => `
            <label class="option"><input type="radio" name="shippingMethod" value="${esc(m.id)}" ${i === 0 ? "checked" : ""}>
              <span><b>${esc(m.name)}</b>${m.cities ? `<br><span class="muted">السعر حسب المدينة</span>` : ""}</span></label>`).join("")}
        </div>
        <div data-delivery>
          <div class="field" data-city-field><label for="city">المدينة</label>
            <select id="city" name="shippingCity"><option value="">اختر المدينة</option></select><div class="error"></div></div>
          <div class="field"><label for="address">العنوان بالتفصيل</label>
            <textarea id="address" name="shippingAddress" rows="2" placeholder="المنطقة، الشارع، أقرب معلم"></textarea><div class="error"></div></div>
        </div>

        <h3>طريقة الدفع</h3>
        <div class="options">
          ${payments.map((p, i) => `
            <label class="option"><input type="radio" name="paymentMethod" value="${esc(p.id)}" ${i === 0 ? "checked" : ""}><b>${esc(p.name)}</b></label>`).join("")}
        </div>
        <button class="btn btn-block" type="submit" data-submit>تأكيد الطلب</button>
      </form>

      <aside class="panel summary">
        <h3>طلبك</h3>
        ${cart.items.map((i) => `<div class="line"><span>${esc(i.name)} × ${i.quantity}</span><span>${money(i.lineTotal)}</span></div>`).join("")}
        <div class="line"><span>المجموع</span><span>${money(cart.total)}</span></div>
        <div class="line"><span>التوصيل</span><span data-shipping>—</span></div>
        <div class="line total"><span>الإجمالي</span><span data-total>${money(cart.total)}</span></div>
      </aside>
    </div>`;

  const form = app.querySelector("[data-form]");
  const citySelect = form.querySelector("#city");
  const cityField = form.querySelector("[data-city-field]");
  const delivery = form.querySelector("[data-delivery]");
  const selectedMethod = () => methods.find((m) => m.id === form.shippingMethod.value);
  // Remembered separately from the <select>: switching to pickup and back must not lose the chosen city.
  let chosenCity = "";

  function syncMethod() {
    const method = selectedMethod();
    const isPickup = method?.id === "pickup";
    delivery.classList.toggle("hidden", isPickup);
    cityField.classList.toggle("hidden", !method?.cities);
    citySelect.innerHTML = `<option value="">اختر المدينة</option>` +
      (method?.cities ?? []).map((c) => `<option ${c === chosenCity ? "selected" : ""}>${esc(c)}</option>`).join("");
    updateQuote();
  }

  async function updateQuote() {
    const method = selectedMethod();
    const shippingEl = app.querySelector("[data-shipping]");
    const totalEl = app.querySelector("[data-total]");
    if (method?.cities && !citySelect.value) {
      shippingEl.textContent = "اختر المدينة";
      totalEl.textContent = money(cart.total);
      return;
    }
    try {
      const quote = await api("/checkout/quote", {
        method: "POST",
        body: {
          cartId: cart.id,
          shippingAddress: QUOTE_ADDRESS,
          shippingMethod: method?.id,
          ...(method?.cities ? { shippingCity: citySelect.value } : {}),
        },
      });
      shippingEl.textContent = quote.shippingCost === 0 ? "مجاناً" : money(quote.shippingCost);
      totalEl.textContent = money(quote.total);
    } catch (err) {
      shippingEl.textContent = "—";
      showFormError(errorText(err));
    }
  }

  function showFormError(message) {
    app.querySelector("[data-form-error]").innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : "";
  }

  function setFieldError(name, message) {
    const input = form.elements.namedItem(name);
    // Radio groups come back as a RadioNodeList, not one element - they have no error slot.
    if (!(input instanceof Element)) return;
    const field = input.closest(".field");
    if (!field) return;
    field.classList.toggle("invalid", Boolean(message));
    field.querySelector(".error").textContent = message ?? "";
  }

  function validate() {
    const method = selectedMethod();
    const errors = {
      contactName: form.contactName.value.trim() ? null : "الاسم مطلوب",
      contactPhone: PHONE.test(form.contactPhone.value.trim()) ? null : "أدخل رقم هاتف صحيح، مثال: 0912345678",
      shippingCity: method?.cities && !citySelect.value ? "اختر المدينة" : null,
      shippingAddress:
        method?.id !== "pickup" && form.shippingAddress.value.trim().length < 5 ? "اكتب العنوان بالتفصيل (5 أحرف على الأقل)" : null,
    };
    for (const [name, message] of Object.entries(errors)) setFieldError(name, message);
    return Object.values(errors).every((e) => e === null);
  }

  // A field's error disappears as soon as the shopper edits that field.
  form.addEventListener("input", (e) => setFieldError(e.target.name, null));

  form.addEventListener("change", (e) => {
    setFieldError(e.target.name, null);
    if (e.target.name === "shippingMethod") syncMethod();
    if (e.target.name === "shippingCity") {
      chosenCity = citySelect.value;
      updateQuote();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showFormError(null);
    if (!validate()) return;
    const method = selectedMethod();
    const submit = form.querySelector("[data-submit]");
    submit.disabled = true;
    submit.textContent = "جاري إرسال الطلب...";
    try {
      const order = await api("/orders", {
        method: "POST",
        body: {
          cartId: cart.id,
          contactName: form.contactName.value.trim(),
          contactPhone: form.contactPhone.value.trim(),
          shippingAddress: method.id === "pickup" ? PICKUP_ADDRESS : form.shippingAddress.value.trim(),
          ...(method.cities ? { shippingCity: citySelect.value } : {}),
          shippingMethod: method.id,
          paymentMethod: form.paymentMethod.value,
        },
      });
      setCartId(null);
      refreshCartBadge();
      showSuccess(order);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "تأكيد الطلب";
      if (err instanceof ApiError && Array.isArray(err.details)) {
        for (const d of err.details) setFieldError(d.field, errorText({ status: 400, details: [d] }));
      }
      showFormError(errorText(err));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  syncMethod();
}

function showSuccess(order) {
  const trackUrl = `track.html?id=${encodeURIComponent(order.id)}&phone=${encodeURIComponent(order.contactPhone)}`;
  app.innerHTML = `
    <div class="panel narrow empty">
      <div class="big">✅ تم استلام طلبك بنجاح</div>
      <p>شكراً لك ${esc(order.contactName)}! سنتصل بك على <span class="ltr">${esc(order.contactPhone)}</span> لتأكيد الطلب.</p>
      <p>رقم الطلب:<br><span class="order-id">${esc(order.id)}</span></p>
      <p><b>الإجمالي: ${money(order.total)}</b>${order.shippingCity ? ` — التوصيل إلى ${esc(order.shippingCity)}` : ""}</p>
      ${order.payment?.instructions ? `<div class="alert info">${esc(order.payment.instructions)}</div>` : ""}
      <a class="btn" href="${trackUrl}">تتبّع الطلب</a>
      <a class="btn btn-light" href="index.html">متابعة التسوق</a>
    </div>`;
}

load().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل صفحة الطلب</div><p>${esc(errorText(err))}</p>
    <a class="btn" href="cart.html">العودة للسلة</a></div>`;
});
