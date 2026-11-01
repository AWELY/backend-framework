/**
 * ما يحفظه الموقع في المتصفح (localStorage): رقم السلة، وجلسة الزبون، وجلسة الموظف.
 *
 * التوكن يُحفظ هنا ليبقى الزبون داخلاً بعد إغلاق الصفحة. الخطر المعروف: سكربت خبيث في الصفحة
 * (XSS) يستطيع قراءته. لهذا: CSP صارمة (لا سكربت من خارج الموقع ولا داخل الصفحة)، وكل نص من
 * الـ API يمر بـ esc() قبل عرضه. والجلسة تُلغى من الخادم عند الخروج (POST /customers/logout).
 *
 * مفتاح المالك (X-Api-Key) لا يُحفظ أبداً في localStorage: في sessionStorage فقط، فيُنسى عند إغلاق التبويب.
 * كل القراءة والكتابة داخل try: المتصفح في الوضع الخاص قد يمنع التخزين.
 */
const KEYS = {
  cart: "maa.cartId",
  token: "maa.token",
  customer: "maa.customer",
  staffToken: "maa.staffToken",
  staff: "maa.staff",
  ownerKey: "maa.ownerKey",
};

function read(key, storage = localStorage) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value, storage = localStorage) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // التخزين ممنوع: يعمل الموقع دون حفظ.
  }
}

function readJson(key, storage) {
  try {
    return JSON.parse(read(key, storage) ?? "null");
  } catch {
    return null;
  }
}

export const getCartId = () => read(KEYS.cart);
export const setCartId = (id) => write(KEYS.cart, id);

export const getToken = () => read(KEYS.token);
/** بيانات الزبون المحفوظة (الاسم والبريد) لعرضها في الرأس، أو null. */
export const getCustomer = () => readJson(KEYS.customer);

/** بعد الدخول أو التسجيل: نحفظ التوكن، والاسم والبريد فقط (لا شيء حساساً آخر). */
export function saveSession(token, customer) {
  write(KEYS.token, token);
  write(KEYS.customer, JSON.stringify({ name: customer.name, email: customer.email }));
}

/** تسجيل الخروج من المتصفح (الخادم يُلغي الجلسة في api.js). */
export function clearSession() {
  write(KEYS.token, null);
  write(KEYS.customer, null);
}

/** جلسة الموظف (لوحة الإدارة وتطبيق المندوب). */
export const getStaffToken = () => read(KEYS.staffToken);
export const getStaff = () => readJson(KEYS.staff);
export function saveStaffSession(token, staff) {
  write(KEYS.staffToken, token);
  write(KEYS.staff, JSON.stringify({ id: staff.id, name: staff.name, role: staff.role, email: staff.email }));
}
export function clearStaffSession() {
  write(KEYS.staffToken, null);
  write(KEYS.staff, null);
  write(KEYS.ownerKey, null, sessionStorage);
}

/** وضع المالك: المفتاح في sessionStorage فقط. */
export const getOwnerKey = () => read(KEYS.ownerKey, sessionStorage);
export const setOwnerKey = (key) => write(KEYS.ownerKey, key, sessionStorage);
