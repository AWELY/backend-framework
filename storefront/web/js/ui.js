import { STORE } from "./config.js";
import { getCustomer } from "./store.js";
import { api, getExistingCart, addToCart } from "./api.js";
import { icon } from "./icons.js";

export { icon };

const PLACEHOLDER = "images/placeholder.svg";

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

/** The same price as HTML, with the currency set smaller than the amount. */
export function priceHtml(dirhams) {
  const [amount, currency] = money(dirhams).split(" ");
  return `<span class="amount">${amount}</span> <span class="currency">${currency}</span>`;
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

let categoriesPromise;
/** The category list, fetched once per page and shared by the header, footer and page. */
export function getCategories() {
  categoriesPromise ??= api("/categories").catch(() => []);
  return categoriesPromise;
}

/** One product card - the same on the home page, search results and "similar products". */
export function productCard(p, quantity, categoryName) {
  const url = `product.html?id=${encodeURIComponent(p.id)}`;
  const soldOut = quantity <= 0;
  return `
    <article class="card${soldOut ? " sold-out" : ""}">
      <a class="thumb" href="${url}" tabindex="-1">
        <img src="${esc(p.imageUrl ?? PLACEHOLDER)}" alt="${esc(p.name)}" loading="lazy">
        ${quantity <= 3 ? stockBadge(quantity) : ""}
      </a>
      <div class="body">
        ${categoryName ? `<span class="card-cat">${esc(categoryName)}</span>` : ""}
        <a class="name" href="${url}">${esc(p.name)}</a>
        <div class="price">${priceHtml(p.price)}</div>
        <button class="add-btn" data-add="${esc(p.id)}" ${soldOut ? "disabled" : ""}>
          ${soldOut ? "نفدت الكمية" : `${icon("cartPlus", 18)}<span>أضف إلى السلة</span>`}
        </button>
      </div>
    </article>`;
}

/** Wires every [data-add] button inside root: adds one piece, then confirms on the button itself. */
export function bindAddButtons(root) {
  root.querySelectorAll("[data-add]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const original = btn.innerHTML;
      btn.disabled = true;
      try {
        await addToCart(btn.dataset.add, 1);
        btn.classList.add("added");
        btn.innerHTML = `${icon("check", 18)}<span>تمت الإضافة</span>`;
        toast("تمت الإضافة إلى السلة");
        refreshCartBadge();
        setTimeout(() => {
          btn.classList.remove("added");
          btn.innerHTML = original;
        }, 1600);
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        btn.disabled = false;
      }
    })
  );
}

/** Header, category bar, footer and the common chrome, injected into every page. */
export function mountLayout(active) {
  const customer = getCustomer();
  const accountHref = customer ? "orders.html" : "account.html";
  const currentCategory = qs("category");
  const header = document.createElement("div");
  header.innerHTML = `
    <div class="topbar"><div class="container">
      <div class="topbar-group">
        <span>${icon("truck", 16)} توصيل لكل المدن الليبية</span>
        <span class="hide-sm">${icon("cash", 16)} الدفع نقداً عند الاستلام</span>
      </div>
      <div class="topbar-group">
        <span>${icon("pin", 16)} ${esc(STORE.address)}</span>
        <span class="hide-sm">${icon("clock", 16)} يومياً 10 ص - 10 م</span>
      </div>
    </div></div>
    <header class="site-header"><div class="container">
      <a class="logo" href="index.html" aria-label="${esc(STORE.name)}"><img src="images/logo.svg" alt="${esc(STORE.name)}"></a>
      <form class="search" action="index.html" role="search">
        <input name="q" type="search" placeholder="ابحث عن شاحن، سماعات، ساعة..." value="${esc(qs("q") ?? "")}" aria-label="بحث">
        <button type="submit" aria-label="بحث">${icon("search", 20)}</button>
      </form>
      <nav class="nav">
        <a href="track.html" class="${active === "track" ? "active" : ""}">${icon("package", 22)}<span class="label">تتبّع طلبك</span></a>
        <a href="${accountHref}" class="${active === "account" ? "active" : ""}">${icon("user", 22)}<span class="label">${customer ? esc(customer.name) : "حسابي"}</span></a>
        <a href="cart.html" class="cart-link ${active === "cart" ? "active" : ""}">${icon("cart", 22)}<span class="label">السلة</span><span class="badge" data-cart-count>0</span></a>
      </nav>
    </div></header>
    <nav class="catbar" aria-label="الأقسام"><div class="container" data-catbar>
      <a href="index.html#products" class="${active === "home" && !currentCategory ? "active" : ""}">${icon("grid", 16)} كل المنتجات</a>
    </div></nav>`;
  document.body.prepend(...header.children);

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container footer-grid">
      <div class="footer-about">
        <img src="images/logo-light.svg" alt="${esc(STORE.name)}" class="footer-logo">
        <p>${esc(STORE.tagline)} في ${esc(STORE.address)}. منتجات مختارة بأسعار مناسبة، وتوصيل لكل ليبيا.</p>
        <div class="footer-badges">
          <span>${icon("cash", 16)} الدفع عند الاستلام</span>
          <span>${icon("truck", 16)} توصيل لكل المدن</span>
        </div>
      </div>
      <div><h4>الأقسام</h4><ul data-footer-cats></ul></div>
      <div><h4>خدمة العملاء</h4><ul>
        <li><a href="track.html">تتبّع طلبك</a></li>
        <li><a href="${accountHref}">${customer ? "طلباتي" : "حسابي"}</a></li>
        <li><a href="cart.html">سلة التسوق</a></li>
      </ul></div>
      <div><h4>تواصل معنا</h4><ul class="contact">
        <li>${icon("pin", 16)} ${esc(STORE.address)}</li>
        <li>${icon("clock", 16)} يومياً من 10 صباحاً حتى 10 مساءً</li>
        ${STORE.whatsapp ? `<li>${icon("chat", 16)} <a class="ltr" href="https://wa.me/${encodeURIComponent(STORE.whatsapp)}" target="_blank" rel="noopener">+${esc(STORE.whatsapp)}</a></li>` : ""}
      </ul></div>
    </div>
    <div class="footer-bottom"><div class="container">
      <span>© ${new Date().getFullYear()} ${esc(STORE.name)} — جميع الحقوق محفوظة</span>
      <span class="muted-light">صور المنتجات للعرض التوضيحي</span>
    </div></div>`;
  document.body.append(footer);

  getCategories().then((categories) => {
    const bar = document.querySelector("[data-catbar]");
    bar?.insertAdjacentHTML("beforeend", categories.map((c) =>
      `<a href="index.html?category=${encodeURIComponent(c.id)}#products" class="${c.id === currentCategory ? "active" : ""}">${esc(c.name)}</a>`).join(""));
    document.querySelector("[data-footer-cats]")?.insertAdjacentHTML("beforeend", categories.map((c) =>
      `<li><a href="index.html?category=${encodeURIComponent(c.id)}#products">${esc(c.name)}</a></li>`).join(""));
  });

  if (STORE.whatsapp) {
    const wa = document.createElement("a");
    wa.href = `https://wa.me/${encodeURIComponent(STORE.whatsapp)}`;
    wa.className = "whatsapp";
    wa.target = "_blank";
    wa.rel = "noopener";
    wa.setAttribute("aria-label", "تواصل معنا على واتساب");
    wa.innerHTML = `${icon("chat", 26)}`;
    document.body.append(wa);
  }

  refreshCartBadge();
}
