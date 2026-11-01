/**
 * إعدادات الموقع في مكان واحد.
 *
 * API_BASE: عنوان الـ API. الافتراضي نفس اسم الخادم على المنفذ 3000، فيعمل على الجهاز
 * (localhost) وعلى أي عنوان في الشبكة المحلية دون تعديل. يمكن تغييره بتعريف window.MAA_API_BASE.
 */
const API_PORT = 3000;

export const API_BASE = window.MAA_API_BASE ?? `${location.protocol}//${location.hostname}:${API_PORT}`;

/** بيانات المتجر التي تظهر في الرأس والتذييل. */
export const STORE = {
  name: "متجر ماء",
  latinName: "Maa Store",
  tagline: "إلكترونيات وإكسسوارات الهواتف",
  address: "طرابلس - تاجوراء",
  whatsapp: "",
};
