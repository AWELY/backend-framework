// أدوات العرض المشتركة بين كل صفحات الموقع: الحماية من XSS، وتنسيق الأسعار والتواريخ،
// وترجمة أخطاء الـ API إلى رسائل عربية، وبطاقة المنتج، والرأس والتذييل.
import { STORE } from "./config.js";
import { getCustomer } from "./store.js";
import { api, getExistingCart, addToCart } from "./api.js";
import { icon } from "./icons.js";

// نعيد تصدير icon، فتستوردها الصفحات من ui.js مع باقي الأدوات.
export { icon };

// صورة بديلة للمنتج الذي ليست له صورة.
const PLACEHOLDER = "images/placeholder.svg";

/**
 * يحوّل الرموز الخاصة في HTML إلى نص عادي قبل وضع أي قيمة في الصفحة.
 * كل قيمة تأتي من الـ API تمر من هنا، بلا استثناء.
 *
 * لماذا؟ الصفحات تُبنى بنصوص HTML (innerHTML). لو كان اسم منتج مثلاً:
 *   <img src=x onerror="سرقة التوكن">
 * ووُضع كما هو، لنفّذه المتصفح كـ HTML، وهذا هجوم XSS. بعد esc يصبح:
 *   &lt;img src=x onerror=&quot;...&quot;&gt;
 * فيظهر للمشتري نصاً عادياً ولا يعمل. اختبار المتصفح (tests/browser.mjs) يثبت هذا فعلاً
 * بمنتج اسمه فيه HTML.
 * و "&" تُستبدل أولاً، وإلا لأفسدنا الرموز التي أضفناها نحن (مثل &lt;).
 */
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * يحوّل الدراهم إلى نص بالدينار (1 دينار = 1000 درهم):
 *   35000 يصبح "35 د.ل"، و 12500 يصبح "12.5 د.ل"، و 1250000 يصبح "1,250 د.ل".
 * الأصفار الزائدة بعد الفاصلة تُحذف (toFixed(3) ثم replace).
 */
export function money(dirhams) {
  const lyd = dirhams / 1000;
  const text = Number.isInteger(lyd) ? String(lyd) : lyd.toFixed(3).replace(/0+$/, "");
  return `${Number(text).toLocaleString("en-US", { maximumFractionDigits: 3 })} د.ل`;
}

/** نفس السعر كـ HTML، مع العملة بخط أصغر من المبلغ (التنسيق في styles.css). */
export function priceHtml(dirhams) {
  const [amount, currency] = money(dirhams).split(" ");
  return `<span class="amount">${amount}</span> <span class="currency">${currency}</span>`;
}

/**
 * السعر داخل "ملصق السعر" البرتقالي (العنصر المميز في تصميم المتجر، .tag في styles.css).
 * large: الملصق الكبير في صفحة المنتج. off: ملصق رمادي للمنتج الذي نفد.
 * الأرقام فقط تدخل هنا (لا نص من المستخدم)، فلا حاجة لـ esc.
 */
export function priceTag(dirhams, { large = false, off = false } = {}) {
  return `<span class="tag${large ? " tag-lg" : ""}${off ? " off" : ""}">${priceHtml(dirhams)}</span>`;
}

/** شارة حالة المخزون: نفد، أو "باقي 3 فقط" إن كان 3 أو أقل، أو متوفر. */
export function stockBadge(quantity) {
  if (quantity <= 0) return `<span class="stock out">نفدت الكمية</span>`;
  if (quantity <= 3) return `<span class="stock low">باقي ${quantity} فقط</span>`;
  return `<span class="stock in">متوفر</span>`;
}

// ترجمة حالات الطلب (القيم الإنجليزية من الـ API) إلى عبارات للمشتري.
export const ORDER_STATUS = {
  pending: "قيد المراجعة",
  confirmed: "تم التأكيد",
  shipped: "في الطريق إليك",
  delivered: "تم التوصيل",
  cancelled: "ملغي",
};

// ترجمة حالات الدفع. في هذا المتجر "pending" تعني الدفع عند الاستلام.
export const PAYMENT_STATUS = {
  unpaid: "غير مدفوع",
  pending: "الدفع عند الاستلام",
  paid: "مدفوع",
  failed: "فشل الدفع",
  refunded: "مسترجع",
};

/** يعرض تاريخاً من الـ API (صيغة ISO) بالتنسيق الليبي العربي، مع الوقت. */
export function formatDate(iso) {
  return new Date(iso).toLocaleString("ar-LY", { dateStyle: "medium", timeStyle: "short" });
}

/** يقرأ قيمة من استعلام رابط الصفحة. مثال: في product.html?id=abc تعطي qs("id") القيمة "abc". */
export const qs = (name) => new URLSearchParams(location.search).get(name);

// أسماء حقول الـ API بالعربية، لرسائل أخطاء التحقق (400).
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
  // حقول لوحة التحكم وتطبيق المندوب.
  slug: "الاسم في الرابط",
  price: "السعر",
  description: "الوصف",
  imageUrl: "رابط الصورة",
  categoryId: "القسم",
  role: "الدور",
  courierId: "المندوب",
  note: "الملاحظة",
  delta: "مقدار التغيير",
};

/** يترجم رسالة مشكلة حقل من مدقّق الإطار (engine/validation.ts) إلى العربية. */
function fieldMessage(message) {
  if (message === "is required") return "مطلوب";
  if (message === "has an invalid format") return "صيغته غير صحيحة";
  if (message.startsWith("must be at least")) return `قصير جداً (${message.match(/\d+/)?.[0] ?? ""} أحرف على الأقل)`;
  if (message.startsWith("must be one of")) return "اختر قيمة من القائمة";
  if (message === "must be an active courier") return "اختر مندوباً نشطاً";
  if (message.startsWith("must be at most") || message.startsWith("must be no more")) return "أطول من المسموح";
  return "قيمة غير صحيحة";
}

/**
 * يحوّل خطأ من الـ API إلى رسالة عربية واضحة للمشتري.
 * الـ API يرد بالإنجليزية (لغة المطورين)، والموقع هو من يقرر ما يقوله للمستخدم.
 * يعتمد على رمز الحالة، وعلى نص الرسالة الثابت من الإطار، وعلى details إن وُجدت.
 */
export function errorText(err) {
  if (!err || err.status === undefined) return "حدث خطأ غير متوقع، حاول مرة أخرى.";
  // 0: لا رد أصلاً (انظر ApiError في api.js).
  if (err.status === 0) return "تعذّر الاتصال بخادم المتجر. تأكد من الاتصال وأعد المحاولة.";
  // 429: حد المحاولات، ونحوّل الثواني إلى دقائق مقرّبة للأعلى.
  if (err.status === 429) {
    const minutes = Math.max(1, Math.ceil((err.details?.retryAfterSeconds ?? 60) / 60));
    return `محاولات كثيرة. حاول مرة أخرى بعد ${minutes} دقيقة.`;
  }
  // 409 مخزون غير كافٍ: الإطار يرسل الكمية المتوفرة في details.
  if (err.message === "Insufficient stock") {
    const available = err.details?.available;
    return available !== undefined ? `الكمية غير متوفرة. المتوفر حالياً: ${available}` : "الكمية المطلوبة غير متوفرة حالياً.";
  }
  if (err.message === "Invalid email or password") return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  if (err.message === "A record with the same unique value already exists") return "هذا البريد الإلكتروني مسجّل مسبقاً.";
  if (err.message === "This cart has already been checked out") return "تم إرسال هذه السلة مسبقاً.";
  if (err.message === "Some products in the cart are no longer available") return "بعض المنتجات في سلتك لم تعد متوفرة. احذفها وأعد المحاولة.";
  if (err.message === "The cart is empty") return "سلتك فارغة.";
  // رسائل إضافات المتجر (حسابات الموظفين، والتوصيل، وإلغاء الزبون لطلبه).
  if (err.message === "This account is disabled") return "هذا الحساب موقوف. تواصل مع مدير المتجر.";
  if (err.message === "You cannot disable your own account") return "لا يمكنك إيقاف حسابك أنت.";
  if (err.message === "Only orders under review can be cancelled") return "لا يمكن إلغاء الطلب بعد تأكيده. تواصل مع المتجر.";
  if (err.message === "Only confirmed orders can be assigned to a courier") return "أكّد الطلب أولاً، ثم عيّن له مندوباً.";
  if (err.message === "The courier has already picked up this order") return "استلم المندوب الطلب من المحل، فلا يمكن تغييره الآن.";
  if (err.message === "Pick up the order before delivering it") return "سجّل استلام الطلب من المحل أولاً.";
  if (err.message === "This order is not waiting for pickup") return "هذا الطلب ليس بانتظار الاستلام (ربما أُلغي أو تغيّرت حالته).";
  if (err.message === "This delivery is already completed") return "سُجّل تسليم هذا الطلب من قبل.";
  if (err.message === "Pickup orders do not need a courier") return "طلب الاستلام من المحل لا يحتاج مندوباً.";
  // 409 من آلة حالات الطلب في الإطار، مثل محاولة شحن طلب ملغي.
  if (err.message?.startsWith("Cannot change an order from")) return "لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية.";
  if (err.status === 403) return "ليست لديك صلاحية لهذه العملية.";
  // 400 من مدقّق المدخلات: كل الحقول الخاطئة في سطر واحد، مثل "رقم الهاتف: صيغته غير صحيحة".
  if (err.status === 400 && Array.isArray(err.details) && err.details.length) {
    return err.details.map((d) => `${FIELD_LABELS[d.field] ?? d.field}: ${fieldMessage(d.message)}`).join(" — ");
  }
  if (err.status === 404) return "العنصر المطلوب غير موجود.";
  return "حدث خطأ غير متوقع، حاول مرة أخرى.";
}

// مؤقت الإشعار الحالي، لنلغيه إن ظهر إشعار جديد قبل أن يختفي القديم.
let toastTimer;
/**
 * إشعار صغير يظهر أسفل الشاشة 3 ثوانٍ ثم يختفي (مثل "تمت الإضافة إلى السلة").
 * role="status": قارئ الشاشة للمكفوفين يقرأ النص الجديد تلقائياً.
 * textContent وليس innerHTML: الرسالة تُعرض نصاً دائماً، فلا خطر XSS.
 */
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

/** يحدّث الرقم على أيقونة السلة في الرأس: مجموع الكميات، أو 0 إن لم تكن هناك سلة. */
export async function refreshCartBadge() {
  const badge = document.querySelector("[data-cart-count]");
  if (!badge) return;
  try {
    // getExistingCart لا تنشئ سلة: زيارة صفحة لا تنشئ سلة فارغة لكل زائر.
    const cart = await getExistingCart();
    const count = cart ? cart.items.reduce((sum, i) => sum + i.quantity, 0) : 0;
    badge.textContent = String(count);
  } catch {
    badge.textContent = "0";
  }
}

// وعد قائمة الأقسام، يُحفظ بعد أول طلب.
let categoriesPromise;
/**
 * قائمة الأقسام، تُطلب من الـ API مرة واحدة لكل صفحة، ويتشاركها الرأس والتذييل والصفحة.
 * نحفظ الوعد نفسه (لا النتيجة)، فحتى لو طلبها ثلاثة أجزاء في نفس اللحظة، يذهب طلب واحد.
 * إن فشل الطلب نرجع قائمة فارغة، فلا تنكسر الصفحة بسبب الأقسام.
 */
export function getCategories() {
  categoriesPromise ??= api("/categories").catch(() => []);
  return categoriesPromise;
}

/**
 * بطاقة منتج واحد، بنفس الشكل في الصفحة الرئيسية ونتائج البحث و"منتجات مشابهة".
 * quantity: الكمية في المخزون، لشارة "نفد" أو "باقي قليل" وتعطيل زر الإضافة.
 * encodeURIComponent تحمي الرابط، و esc تحمي كل نص يوضع في HTML.
 * loading="lazy": الصورة لا تُحمَّل إلا عند الاقتراب منها أثناء التمرير، فتفتح الصفحة أسرع.
 */
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
        <div class="price">${priceTag(p.price, { off: soldOut })}</div>
        <button class="add-btn" data-add="${esc(p.id)}" ${soldOut ? "disabled" : ""}>
          ${soldOut ? "نفدت الكمية" : `${icon("cartPlus", 18)}<span>أضف إلى السلة</span>`}
        </button>
      </div>
    </article>`;
}

/**
 * يربط كل زر [data-add] داخل root: يضيف قطعة واحدة إلى السلة، ثم يؤكد على الزر نفسه
 * ("تمت الإضافة") لمدة 1.6 ثانية.
 * الزر يُعطَّل أثناء الطلب، فالضغط المزدوج السريع لا يضيف قطعتين.
 */
export function bindAddButtons(root) {
  root.querySelectorAll("[data-add]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const original = btn.innerHTML;
      btn.disabled = true;
      try {
        // dataset.add هي قيمة data-add، أي رقم المنتج.
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

/**
 * يبني الأجزاء المشتركة ويضيفها إلى كل صفحة: الشريط العلوي، والرأس (الشعار والبحث والروابط)،
 * وشريط الأقسام، والتذييل، وزر واتساب.
 * active: اسم الصفحة الحالية ("home" أو "cart"...) لتمييز رابطها.
 *
 * لماذا تُبنى بـ JavaScript ولا تُكتب في كل ملف HTML؟ حتى لا نكررها في 7 صفحات: أي تعديل
 * على الرأس يحدث هنا مرة واحدة.
 */
export function mountLayout(active) {
  const customer = getCustomer();
  // المسجل دخوله يذهب إلى منطقة حسابه (طلباته)، والزائر إلى صفحة الدخول.
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
  // prepend: الرأس في أول الصفحة، قبل محتواها. و "..." تنقل كل العناصر الأبناء دفعة واحدة.
  document.body.prepend(...header.children);

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container footer-grid">
      <div class="footer-about">
        <img src="images/logo-light.svg" alt="${esc(STORE.name)}" class="footer-logo">
        <p>${esc(STORE.tagline)} في ${esc(STORE.address)}. نوصّل لكل المدن الليبية، وتدفع نقداً عند الاستلام.</p>
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
      <span>© ${new Date().getFullYear()} ${esc(STORE.name)}. جميع الحقوق محفوظة. صور المنتجات للعرض التوضيحي.</span>
      <nav aria-label="دخول الموظفين">
        <a href="admin/login.html">لوحة المتجر</a>
        <a href="courier/index.html">تطبيق المندوب</a>
      </nav>
    </div></div>`;
  document.body.append(footer);

  // الأقسام تصل من الـ API لاحقاً: نضيفها إلى شريط الأقسام وإلى التذييل عند وصولها،
  // فلا ينتظر عرض الصفحة هذا الطلب. "?." تتجاوز العنصر إن لم يوجد في الصفحة.
  getCategories().then((categories) => {
    const bar = document.querySelector("[data-catbar]");
    bar?.insertAdjacentHTML("beforeend", categories.map((c) =>
      `<a href="index.html?category=${encodeURIComponent(c.id)}#products" class="${c.id === currentCategory ? "active" : ""}">${esc(c.name)}</a>`).join(""));
    document.querySelector("[data-footer-cats]")?.insertAdjacentHTML("beforeend", categories.map((c) =>
      `<li><a href="index.html?category=${encodeURIComponent(c.id)}#products">${esc(c.name)}</a></li>`).join(""));
  });

  // زر واتساب العائم، فقط إن ضُبط رقم في config.js.
  // rel="noopener": الصفحة الجديدة لا تستطيع التحكم في صفحتنا عبر window.opener.
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
