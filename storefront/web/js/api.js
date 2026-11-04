// الاتصال بالـ API: كل صفحات الموقع تمر من هنا. الموقع لا يعرف شيئاً عن قاعدة البيانات،
// بل يرسل طلبات HTTP فقط، كأي عميل آخر (Headless).
import { API_BASE } from "./config.js";
import { getToken, clearSession, getCartId, setCartId, getStaffSession, clearStaffSession } from "./store.js";

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
 * الطلب الخام إلى الـ API: يرسل الجسم كـ JSON، والتوكن المعطى (إن وُجد) في ترويسة Authorization،
 * ويرجع { res, data }. لا يقرر شيئاً عند الخطأ: api() و staffApi() أدناه تقرران.
 */
async function request(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
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
  return { res, data };
}

/** يحوّل رد الخطأ إلى ApiError بالشكل الموحد لأخطاء الإطار: { error: { message, details } }. */
const toError = (res, data) => new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.details ?? null);

/**
 * يستدعي الـ API من صفحات المتجر، ويرسل توكن دخول الزبون إن وُجد.
 *
 * إن انتهت صلاحية التوكن (401)، تُمسح الجلسة ويُعاد الطلب مرة واحدة كضيف. هكذا لا يكسر
 * دخول قديم منتهٍ الصفحات العامة: يرى الزائر المنتجات بدل رسالة خطأ.
 *
 * مثال: await api("/products") ترجع قائمة المنتجات،
 *       و await api("/carts", { method: "POST" }) تنشئ سلة.
 */
export async function api(path, { method = "GET", body, retried = false } = {}) {
  const token = getToken();
  const { res, data } = await request(path, { method, body, token });
  if (!res.ok) {
    // توكن منتهٍ أو غير صالح: نمسح الجلسة، ونعيد الطلب نفسه مرة واحدة فقط (retried) كضيف.
    if (res.status === 401 && token && !retried && data?.error?.message === "Invalid or expired token") {
      clearSession();
      return api(path, { method, body, retried: true });
    }
    throw toError(res, data);
  }
  return data;
}

// ما تفعله الصفحة حين تنتهي جلسة الموظف (تضبطه لوحة التحكم وتطبيق المندوب: الانتقال لصفحة الدخول).
let onStaffExpired = () => {};
export const setStaffExpiredHandler = (handler) => {
  onStaffExpired = handler;
};

/**
 * يستدعي الـ API من لوحة التحكم وتطبيق المندوب، بتوكن الموظف (لا توكن الزبون).
 *
 * 401 بتوكن موجود يعني: انتهت مدته (12 ساعة)، أو أوقف المدير الحساب. نمسح الجلسة ونستدعي
 * onStaffExpired لتعيد الصفحة الموظف إلى الدخول. لا نعيد المحاولة كضيف: صفحات الموظفين لا
 * معنى لها بلا دخول.
 */
export async function staffApi(path, { method = "GET", body } = {}) {
  const token = getStaffSession()?.token;
  const { res, data } = await request(path, { method, body, token });
  if (!res.ok) {
    if (res.status === 401 && token) {
      clearStaffSession();
      onStaffExpired();
    }
    throw toError(res, data);
  }
  return data;
}

/** دخول الموظف: لا يرسل أي توكن، ويرجع { staff, token } أو يرمي ApiError. */
export async function staffLogin(email, password) {
  const { res, data } = await request("/staff/login", { method: "POST", body: { email, password } });
  if (!res.ok) throw toError(res, data);
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
