import { API_BASE } from "./config.js";
import { getToken, clearSession, getCartId, setCartId, getStaffToken, getOwnerKey } from "./store.js";

/**
 * خطأ من الـ API. code هو الرمز الثابت من الإطار (مثل "INSUFFICIENT_STOCK")، والواجهة تقرر به،
 * لا بنص الرسالة. status = 0 يعني أن الـ API لم يُصَل إليه أصلاً (الخادم متوقف، أو لا اتصال).
 * requestId يظهر في رسالة الخطأ للزبون، فيذكره لخدمة العملاء ويُعثر على الطلب في سجل الخادم.
 */
export class ApiError extends Error {
  constructor(status, message, details, code = null, requestId = null) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
    this.requestId = requestId;
  }
}

/** ترويسات المصادقة حسب من يستدعي: الزبون، أو الموظف (أو المالك بمفتاحه)، أو لا أحد. */
function authHeaders(auth) {
  if (auth === "customer") {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (auth === "staff") {
    const owner = getOwnerKey();
    if (owner) return { "X-Api-Key": owner };
    const token = getStaffToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {};
}

/**
 * يستدعي الـ API. يرجع { data, headers }.
 *   auth: "customer" (الافتراضي) | "staff" | "none"
 *   idempotencyKey: يرسل Idempotency-Key (الشراء والاسترجاع: الإعادة لا تكرر العملية)
 *   ifMatch: يرسل If-Match (التعديل المتفائل: 412 إن عدّل غيرك قبلك)
 *
 * توكن زبون منتهٍ أو ملغى (INVALID_TOKEN): تُمسح الجلسة ويُعاد الطلب مرة واحدة كضيف، فلا يكسر
 * دخول قديم الصفحات العامة.
 */
export async function request(path, { method = "GET", body, auth = "customer", idempotencyKey, ifMatch, retried = false } = {}) {
  const headers = { ...authHeaders(auth) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (ifMatch) headers["If-Match"] = ifMatch;

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network", null, "NETWORK");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = data?.error ?? {};
    if (res.status === 401 && auth === "customer" && headers.Authorization && !retried && error.code === "INVALID_TOKEN") {
      clearSession();
      return request(path, { method, body, auth, idempotencyKey, ifMatch, retried: true });
    }
    throw new ApiError(res.status, error.message ?? res.statusText, error.details ?? null, error.code ?? null, error.requestId ?? null);
  }
  return { data, headers: res.headers };
}

/** نفس request لكن يرجع البيانات فقط. مثال: await api("/products") */
export async function api(path, options) {
  return (await request(path, options)).data;
}

/** قائمة مع عددها الكلي (من ترويسة X-Total-Count): { items, total }. */
export async function apiPage(path, options) {
  const { data, headers } = await request(path, options);
  return { items: data ?? [], total: Number(headers.get("X-Total-Count") ?? data?.length ?? 0) };
}

/** مفتاح عشوائي لـ Idempotency-Key. */
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * سلة الزائر المفتوحة، وتُنشأ عند أول حاجة إليها. الزبون الداخل يأخذ سلته المحفوظة في الخادم
 * (GET /carts/mine) إن لم تكن في المتصفح سلة، فيجد سلته على أي جهاز.
 */
export async function getOrCreateCart() {
  const existing = await getExistingCart();
  if (existing) return existing;
  const cart = await api("/carts", { method: "POST" });
  setCartId(cart.id);
  return cart;
}

/** السلة المحفوظة دون إنشاء سلة جديدة (null إن لم تكن للزائر سلة بعد). */
export async function getExistingCart() {
  const id = getCartId();
  if (id) {
    try {
      const cart = await api(`/carts/${id}`);
      if (cart.status === "open") return cart;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
    setCartId(null);
  }
  if (getToken()) {
    // 204 (لا سلة مفتوحة) يصل هنا null.
    const mine = await api("/carts/mine");
    if (mine) {
      setCartId(mine.id);
      return mine;
    }
  }
  return null;
}

/** يضيف منتجاً (أو شكلاً منه) إلى السلة، ويرجع السلة بعد الإضافة. */
export async function addToCart(productId, quantity, variantId) {
  const cart = await getOrCreateCart();
  return api(`/carts/${cart.id}/items`, { method: "POST", body: { productId, quantity, ...(variantId ? { variantId } : {}) } });
}

/** مسار سطر في السلة، مع الشكل إن وُجد. */
export function linePath(cartId, productId, variantId) {
  return `/carts/${cartId}/items/${encodeURIComponent(productId)}${variantId ? `?variantId=${encodeURIComponent(variantId)}` : ""}`;
}

/** تسجيل خروج الزبون: يُلغي الجلسة في الخادم، ثم يمسحها من المتصفح. */
export async function logoutCustomer({ everywhere = false } = {}) {
  await api(everywhere ? "/customers/logout-all" : "/customers/logout", { method: "POST" }).catch(() => undefined);
  clearSession();
  setCartId(null);
}
