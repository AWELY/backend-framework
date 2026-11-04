// أيقونات خطية مرسومة كـ SVG داخل الصفحة (24×24، ولون الخط هو لون النص الحالي currentColor)،
// فتظهر بنفس الشكل على كل جهاز، بعكس الرموز التعبيرية (emoji) التي يختلف شكلها بين الأنظمة.
// لا تحتوي أي خاصية باسم "style"، فتبقى سياسة أمان المحتوى (CSP) صارمة كما هي.
//
// كل مفتاح اسم أيقونة، وقيمته أشكال SVG (path و circle و rect) التي ترسمها.
const PATHS = {
  truck: `<path d="M1 5h13v11H1z"/><path d="M14 9h4.5l3.5 3.5V16h-8"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>`,
  cash: `<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>`,
  store: `<path d="M2.5 9 4.5 4h15l2 5z"/><path d="M4 9v11h16V9"/><path d="M9.5 20v-6h5v6"/>`,
  gift: `<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8C10.5 4 6.5 4 6.5 6.2S9.5 8 12 8zm0 0c1.5-4 5.5-4 5.5-1.8S14.5 8 12 8z"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  cart: `<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21.5 8H6"/>`,
  cartPlus: `<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21.5 8H6"/><path d="M14 9.5v4M12 11.5h4"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>`,
  package: `<path d="m21 8-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>`,
  pin: `<path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7"/>`,
  checkCircle: `<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  trash: `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>`,
  grid: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  arrow: `<path d="M19 12H5M11 18l-6-6 6-6"/>`,
  chat: `<path d="M3 21l1.8-5.2A8.5 8.5 0 1 1 8.2 19.3z"/>`,
  // أيقونات لوحة التحكم وتطبيق المندوب.
  dashboard: `<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/>`,
  receipt: `<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>`,
  box: `<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>`,
  tag: `<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>`,
  users: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.8 3.5 6"/>`,
  bike: `<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 9 9h5l4.5 8M9 9 7.5 6H5M14 9l1.5-3H18"/>`,
  logout: `<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l-5-5 5-5M5 12h11"/>`,
  phone: `<path d="M5 3h3.5l1.5 4.5-2 1.5a12 12 0 0 0 7 7l1.5-2 4.5 1.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>`,
  edit: `<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`,
  eye: `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
  alert: `<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/>`,
  refresh: `<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>`,
  external: `<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
  note: `<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>`,
};

/**
 * يرجع أيقونة كنص HTML جاهز للإدراج في الصفحة، مثل icon("cart", 22).
 * aria-hidden="true": قارئ الشاشة للمكفوفين يتجاهل الأيقونة، لأن النص بجانبها يكفي.
 * اسم غير معروف يعطي SVG فارغاً بدل خطأ.
 */
export function icon(name, size = 20) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}
