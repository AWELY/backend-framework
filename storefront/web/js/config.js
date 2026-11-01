// أين يوجد الـ API الخاص بالمتجر. الافتراضي: نفس عنوان الموقع، على المنفذ 3000.
// غيّر API_PORT لإعداد آخر، أو اضبط window.AMA_API_BASE قبل تحميل السكربتات
// (يستخدمه اختبار المتصفح ليوجّه الموقع إلى API تجريبي على منفذ آخر).
const API_PORT = 3000;

export const API_BASE = window.AMA_API_BASE ?? `${location.protocol}//${location.hostname}:${API_PORT}`;

// معلومات المتجر التي تظهر في الصفحات (الرأس والتذييل).
export const STORE = {
  name: "AMA",
  tagline: "إلكترونيات وإكسسوارات الهواتف",
  address: "طرابلس - تاجوراء",
  // رقم واتساب بالصيغة الدولية دون "+"، مثل "2189XXXXXXXX".
  // إن بقي فارغاً يختفي زر واتساب.
  whatsapp: "",
};
