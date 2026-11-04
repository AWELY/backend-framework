// ما يتذكره المتصفح بين الصفحات: رقم السلة، وجلسة دخول الزبون، وجلسة دخول الموظف.
// localStorage قد لا يكون متاحاً (التصفح الخاص، أو تخزين محظور)، لذلك كل وصول إليه
// محمي بـ try/catch، فيبقى الموقع يعمل، لكن دون أن يتذكر.

// أسماء المفاتيح في localStorage. البادئة "ama." تمنع التصادم مع مواقع أخرى على نفس العنوان.
// جلسة الموظف في مفتاح مستقل عن جلسة الزبون: توكن المدير لا يُرسل أبداً من صفحات المتجر،
// وتوكن الزبون لا يُرسل من لوحة التحكم، حتى لو فُتحا في نفس المتصفح.
const KEYS = { cart: "ama.cartId", token: "ama.token", customer: "ama.customer", staff: "ama.staff" };

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

/** يقرأ قيمة JSON، أو null إن لم توجد أو كانت تالفة. */
function readJson(key) {
  try {
    return JSON.parse(read(key) ?? "null");
  } catch {
    return null;
  }
}

// رقم السلة: يُحفظ عند إنشائها، فيرجع الزائر إلى نفس سلته في كل صفحة.
export const getCartId = () => read(KEYS.cart);
export const setCartId = (id) => write(KEYS.cart, id);

// توكن دخول الزبون: يرسله api.js مع كل طلب من صفحات المتجر.
export const getToken = () => read(KEYS.token);

/** بيانات الزبون المحفوظة (الاسم والبريد) لعرضها في الرأس، أو null. */
export const getCustomer = () => readJson(KEYS.customer);

/** بعد الدخول أو التسجيل: نحفظ التوكن، والاسم والبريد فقط (لا شيء حساساً آخر). */
export function saveSession(token, customer) {
  write(KEYS.token, token);
  write(KEYS.customer, JSON.stringify({ name: customer.name, email: customer.email }));
}

/** يحدّث الاسم المحفوظ بعد تعديل الملف الشخصي، فيظهر الاسم الجديد في الرأس فوراً. */
export function updateSessionCustomer(customer) {
  if (getToken()) write(KEYS.customer, JSON.stringify({ name: customer.name, email: customer.email }));
}

/** تسجيل خروج الزبون: نحذف التوكن وبيانات الزبون من المتصفح. */
export function clearSession() {
  write(KEYS.token, null);
  write(KEYS.customer, null);
}

/**
 * جلسة الموظف (مدير أو مندوب): { token, staff: { id, name, role } } أو null.
 * التوكن مدته 12 ساعة (من الخادم)، وبعدها يرد الخادم 401 فتُمسح الجلسة (staffApi في api.js).
 */
export const getStaffSession = () => readJson(KEYS.staff);

export function saveStaffSession(token, staff) {
  write(KEYS.staff, JSON.stringify({ token, staff: { id: staff.id, name: staff.name, role: staff.role } }));
}

export const clearStaffSession = () => write(KEYS.staff, null);
