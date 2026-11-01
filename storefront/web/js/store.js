// ما يتذكره المتصفح بين الصفحات: رقم السلة، وجلسة الدخول (التوكن واسم الزبون وبريده).
// localStorage قد لا يكون متاحاً (التصفح الخاص، أو تخزين محظور)، لذلك كل وصول إليه
// محمي بـ try/catch، فيبقى الموقع يعمل، لكن دون أن يتذكر.

// أسماء المفاتيح في localStorage. البادئة "ama." تمنع التصادم مع مواقع أخرى على نفس العنوان.
const KEYS = { cart: "ama.cartId", token: "ama.token", customer: "ama.customer" };

/** يقرأ قيمة، أو null إن لم توجد أو تعذرت القراءة. */
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** يكتب قيمة. null تعني الحذف. */
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // التخزين غير متاح: لا شيء نفعله.
  }
}

// رقم السلة: يُحفظ عند إنشائها، فيرجع الزائر إلى نفس سلته في كل صفحة.
export const getCartId = () => read(KEYS.cart);
export const setCartId = (id) => write(KEYS.cart, id);

// توكن الدخول: يرسله api.js مع كل طلب.
export const getToken = () => read(KEYS.token);

/** بيانات الزبون المحفوظة (الاسم والبريد) لعرضها في الرأس، أو null. */
export function getCustomer() {
  try {
    return JSON.parse(read(KEYS.customer) ?? "null");
  } catch {
    return null;
  }
}

/** بعد الدخول أو التسجيل: نحفظ التوكن، والاسم والبريد فقط (لا شيء حساساً آخر). */
export function saveSession(token, customer) {
  write(KEYS.token, token);
  write(KEYS.customer, JSON.stringify({ name: customer.name, email: customer.email }));
}

/** تسجيل الخروج: نحذف التوكن وبيانات الزبون من المتصفح. */
export function clearSession() {
  write(KEYS.token, null);
  write(KEYS.customer, null);
}
