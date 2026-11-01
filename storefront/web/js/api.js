// الاتصال بالـ API: كل صفحات الموقع تمر من هنا. الموقع لا يعرف شيئاً عن قاعدة البيانات،
// بل يرسل طلبات HTTP فقط، كأي عميل آخر (Headless).
import { API_BASE } from "./config.js";
import { getToken, clearSession, getCartId, setCartId } from "./store.js";

/**
 * خطأ من الـ API، يحمل رمز الحالة ورسالة الخطأ وتفاصيله.
 * status = 0 يعني أن الـ API لم يُصَل إليه أصلاً (الخادم متوقف، أو لا اتصال بالشبكة).
 */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * يستدعي الـ API الخاص بالمتجر، ويرسل توكن دخول الزبون إن وُجد.
 *
 * إن انتهت صلاحية التوكن (401)، تُمسح الجلسة ويُعاد الطلب مرة واحدة كضيف. هكذا لا يكسر
 * دخول قديم منتهٍ الصفحات العامة: يرى الزائر المنتجات بدل رسالة خطأ.
 *
 * مثال: await api("/products") ترجع قائمة المنتجات،
 *       و await api("/carts", { method: "POST" }) تنشئ سلة.
 */
export async function api(path, { method = "GET", body, retried = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // لا رد أصلاً (فشل الشبكة): الرمز 0، والصفحة تعرض "تعذر الاتصال بالخادم".
    throw new ApiError(0, "network", null);
  }

  // نقرأ الجسم نصاً أولاً، ثم نحاول تحويله من JSON، فلا ينهار الكود إن لم يكن JSON.
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    // توكن منتهٍ أو غير صالح: نمسح الجلسة، ونعيد الطلب نفسه مرة واحدة فقط (retried) كضيف.
    if (res.status === 401 && token && !retried && data?.error?.message === "Invalid or expired token") {
      clearSession();
      return api(path, { method, body, retried: true });
    }
    // الشكل الموحد لأخطاء الـ API: { error: { message, details } }
    throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.details ?? null);
  }
  return data;
}

/**
 * سلة الزائر المفتوحة، وتُنشأ عند أول حاجة إليها.
 * السلة المحفوظة في المتصفح إن لم تعد موجودة (404)، أو اشتُريت من قبل، تُستبدل بسلة جديدة.
 */
export async function getOrCreateCart() {
  const id = getCartId();
  if (id) {
    try {
      const cart = await api(`/carts/${id}`);
      if (cart.status === "open") return cart;
    } catch (err) {
      // 404 فقط يعني "السلة غير موجودة"، فننشئ غيرها. أي خطأ آخر نمرره كما هو.
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }
  const cart = await api("/carts", { method: "POST" });
  setCartId(cart.id);
  return cart;
}

/**
 * السلة المحفوظة دون إنشاء سلة جديدة (null إن لم تكن للزائر سلة بعد).
 * تستخدمها الصفحات التي تعرض العدد في أيقونة السلة فقط، فلا تنشئ سلة لكل زائر.
 */
export async function getExistingCart() {
  const id = getCartId();
  if (!id) return null;
  try {
    const cart = await api(`/carts/${id}`);
    return cart.status === "open" ? cart : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setCartId(null);
      return null;
    }
    throw err;
  }
}

/** يضيف منتجاً إلى السلة (ينشئ السلة إن لزم)، ويرجع السلة بعد الإضافة. */
export async function addToCart(productId, quantity) {
  const cart = await getOrCreateCart();
  return api(`/carts/${cart.id}/items`, { method: "POST", body: { productId, quantity } });
}
