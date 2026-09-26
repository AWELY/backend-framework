import { STORE } from "./config.js";
import { getCustomer } from "./store.js";
import { getExistingCart } from "./api.js";

/** Escapes text before it goes into HTML - EVERY value from the API passes through this. */
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Dirhams -> "35 د.ل" / "12.5 د.ل" (1 LYD = 1000 dirhams). */
export function money(dirhams) {
  const lyd = dirhams / 1000;
  const text = Number.isInteger(lyd) ? String(lyd) : lyd.toFixed(3).replace(/0+$/, "");
  return `${Number(text).toLocaleString("en-US", { maximumFractionDigits: 3 })} د.ل`;
}

export function stockBadge(quantity) {
  if (quantity <= 0) return `<span class="stock out">نفدت الكمية</span>`;
  if (quantity <= 3) return `<span class="stock low">باقي ${quantity} فقط</span>`;
  return `<span class="stock in">متوفر</span>`;
}

export const ORDER_STATUS = {
  pending: "قيد المراجعة",
  confirmed: "تم التأكيد",
  shipped: "في الطريق إليك",
  delivered: "تم التوصيل",
  cancelled: "ملغي",
};

export const PAYMENT_STATUS = {
  unpaid: "غير مدفوع",
  pending: "الدفع عند الاستلام",
  paid: "مدفوع",
  failed: "فشل الدفع",
  refunded: "مسترجع",
};

export function formatDate(iso) {
  return new Date(iso).toLocaleString("ar-LY", { dateStyle: "medium", timeStyle: "short" });
}

export const qs = (name) => new URLSearchParams(location.search).get(name);

const FIELD_LABELS = {
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  name: "الاسم",
  phone: "رقم الهاتف",
  contactName: "الاسم",
  contactPhone: "رقم الهاتف",
  shippingAddress: "العنوان",
  shippingCity: "المدينة",
  shippingMethod: "طريقة الاستلام",
  paymentMethod: "طريقة الدفع",
  quantity: "الكمية",
};

function fieldMessage(message) {
  if (message === "is required") return "مطلوب";
  if (message === "has an invalid format") return "صيغته غير صحيحة";
  if (message.startsWith("must be at least")) return `قصير جداً (${message.match(/\d+/)?.[0] ?? ""} أحرف على الأقل)`;
  if (message.startsWith("must be one of")) return "اختر قيمة من القائمة";
  return "قيمة غير صحيحة";
}

/** Turns an API error into a clear Arabic message for the shopper. */
export function errorText(err) {
  if (!err || err.status === undefined) return "حدث خطأ غير متوقع، حاول مرة أخرى.";
  if (err.status === 0) return "تعذّر الاتصال بخادم المتجر. تأكد من الاتصال وأعد المحاولة.";
  if (err.status === 429) {
    const minutes = Math.max(1, Math.ceil((err.details?.retryAfterSeconds ?? 60) / 60));
    return `محاولات كثيرة. حاول مرة أخرى بعد ${minutes} دقيقة.`;
  }
  if (err.message === "Insufficient stock") {
    const available = err.details?.available;
    return available !== undefined ? `الكمية غير متوفرة. المتوفر حالياً: ${available}` : "الكمية المطلوبة غير متوفرة حالياً.";
  }
  if (err.message === "Invalid email or password") return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  if (err.message === "A record with the same unique value already exists") return "هذا البريد الإلكتروني مسجّل مسبقاً.";
  if (err.message === "This cart has already been checked out") return "تم إرسال هذه السلة مسبقاً.";
  if (err.message === "Some products in the cart are no longer available") return "بعض المنتجات في سلتك لم تعد متوفرة. احذفها وأعد المحاولة.";
  if (err.message === "The cart is empty") return "سلتك فارغة.";
  if (err.status === 400 && Array.isArray(err.details) && err.details.length) {
    return err.details.map((d) => `${FIELD_LABELS[d.field] ?? d.field}: ${fieldMessage(d.message)}`).join(" — ");
  }
  if (err.status === 404) return "العنصر المطلوب غير موجود.";
  return "حدث خطأ غير متوقع، حاول مرة أخرى.";
}

let toastTimer;
export function toast(message, type = "info") {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle("error", type === "error");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

export async function refreshCartBadge() {
  const badge = document.querySelector("[data-cart-count]");
  if (!badge) return;
  try {
    const cart = await getExistingCart();
    const count = cart ? cart.items.reduce((sum, i) => sum + i.quantity, 0) : 0;
    badge.textContent = String(count);
  } catch {
    badge.textContent = "0";
  }
}

/** Header, footer and the common chrome, injected into every page. */
export function mountLayout(active) {
  const customer = getCustomer();
  const header = document.createElement("div");
  header.innerHTML = `
    <div class="topbar"><div class="container">
      <span>🚚 <strong>توصيل لكل المدن الليبية</strong></span>
      <span>💵 الدفع نقداً عند الاستلام</span>
      <span>📍 ${esc(STORE.address)}</span>
    </div></div>
    <header class="site-header"><div class="container">
      <a class="logo" href="index.html" aria-label="${esc(STORE.name)}"><img src="images/logo.svg" alt="${esc(STORE.name)}"></a>
      <form class="search" action="index.html" role="search">
        <input name="q" type="search" placeholder="ابحث عن شاحن، سماعات، ساعة..." value="${esc(qs("q") ?? "")}">
        <button type="submit">بحث</button>
      </form>
      <nav class="nav">
        <a href="track.html" class="${active === "track" ? "active" : ""}">📦 <span class="label">تتبّع طلبك</span></a>
        <a href="${customer ? "orders.html" : "account.html"}" class="${active === "account" ? "active" : ""}">👤 <span class="label">${customer ? esc(customer.name) : "حسابي"}</span></a>
        <a href="cart.html" class="cart-link">🛒 <span class="label">السلة</span> <span class="badge" data-cart-count>0</span></a>
      </nav>
    </div></header>`;
  document.body.prepend(...header.children);

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container">
      <div><h4>${esc(STORE.name)}</h4><p>${esc(STORE.tagline)}. منتجات مختارة بأسعار مناسبة وتوصيل لكل ليبيا.</p></div>
      <div><h4>روابط</h4>
        <p><a href="index.html">الرئيسية</a><br><a href="track.html">تتبّع طلبك</a><br><a href="${customer ? "orders.html" : "account.html"}">حسابي</a></p></div>
      <div><h4>تواصل معنا</h4><p>📍 ${esc(STORE.address)}<br>🕘 يومياً من 10 صباحاً حتى 10 مساءً</p></div>
    </div>
    <div class="copy">© ${new Date().getFullYear()} ${esc(STORE.name)} — جميع الحقوق محفوظة</div>`;
  document.body.append(footer);

  if (STORE.whatsapp) {
    const wa = document.createElement("a");
    wa.href = `https://wa.me/${encodeURIComponent(STORE.whatsapp)}`;
    wa.className = "btn whatsapp";
    wa.target = "_blank";
    wa.rel = "noopener";
    wa.textContent = "واتساب";
    document.body.append(wa);
  }

  refreshCartBadge();
}
