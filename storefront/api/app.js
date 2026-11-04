const { join } = require("node:path");
// ملف .env في مجلد storefront (المجلد الأعلى من api)، لا في مجلد التشغيل الحالي.
require("dotenv").config({ quiet: true, path: join(__dirname, "..", ".env") });
const {
  loadConfig,
  Logger,
  createCommerceApp,
  AccessControl,
  DEFAULT_ROLES,
  cashOnDelivery,
  cityRateShipping,
  flatRateShipping,
} = require("commerce-framework");
// إضافات خاصة بمتجر AMA (في مجلد plugins): حسابات الموظفين، والتوصيل بالمندوبين، وسجل الطلب
// وإلغاؤه للزبون، وتقارير لوحة التحكم. كلها تستخدم الواجهة العامة للإطار فقط.
const { staffAccounts } = require("./plugins/staff");
const { courierDelivery } = require("./plugins/delivery");
const { customerOrders } = require("./plugins/customer-orders");
const { storeReports } = require("./plugins/reports");

/**
 * الواجهة الخلفية لمتجر AMA كاملة. الإطار يقوم بكل العمل، وهذا الملف فقط "يضبط" الإطار
 * لمتجر إلكترونيات صغير في تاجوراء (طرابلس). المبالغ بالدرهم (1 دينار = 1000).
 *
 * الإطار يصل إلى هنا كحزمة npm عادية (commerce-framework)، من المجلد الأعلى عبر
 * "file:.." في storefront/package.json. أي أن المتجر يستخدم الإطار كمكتبة، تماماً كما
 * سيستخدمه أي متجر آخر.
 */

// سعر التوصيل لكل مدينة. تاجوراء (حيث المحل) الأرخص. والقائمة المنسدلة في الموقع
// تعرض المدن بهذا الترتيب نفسه (الإضافة تنشرها في GET /checkout/options).
// المدينة غير المذكورة هنا لا يصلها التوصيل: إتمام الشراء إليها يُرفض بـ 400.
const DELIVERY_RATES = {
  "تاجوراء": 5000,
  "طرابلس": 10000,
  "جنزور": 12000,
  "القره بوللي": 15000,
  "الزاوية": 15000,
  "صبراتة": 20000,
  "غريان": 20000,
  "الخمس": 20000,
  "زليتن": 20000,
  "مصراتة": 25000,
  "سرت": 35000,
  "بنغازي": 40000,
  "البيضاء": 45000,
  "درنة": 45000,
  "طبرق": 50000,
  "سبها": 50000,
};

/**
 * جدول الأدوار والصلاحيات لهذا المتجر: أدوار الإطار الافتراضية (owner و customer)، ومعها دوران
 * جديدان للموظفين. الإطار يفحص الصلاحية لا اسم الدور (access-control.ts)، فإضافة دور كاملة تعني
 * إضافة سطر هنا فقط، ومسارات الإطار نفسها تقبله فوراً.
 *
 *   admin   (مدير المتجر في لوحة التحكم): المنتجات والأقسام والمخزون والطلبات (orders:* تشمل
 *           orders:read-all و orders:write)، وقراءة الزبائن، وإدارة الموظفين والتوصيل، والتقارير.
 *           ليس عنده cart:manage، فهو لا يشتري بحسابه هذا.
 *   courier (مندوب التوصيل): صلاحية واحدة، العمل على التوصيلات المعيّنة له.
 *
 * owner (مفتاح OWNER_API_KEY) يبقى عنده "*"، أي كل شيء، لـ Postman والسكربتات.
 */
const ROLES = {
  ...DEFAULT_ROLES,
  admin: [
    "products:*",
    "categories:*",
    "inventory:*",
    "orders:*",
    "customers:read",
    "staff:manage",
    "deliveries:manage",
    "reports:read",
  ],
  courier: ["deliveries:work"],
};

/**
 * يبني تطبيق المتجر. ثلاثة ملفات تستخدمها: index.js (التشغيل)، و migrate.js (الجداول)،
 * و seed.js (البيانات الأولية). logLevel اختياري، وإلا يُقرأ من .env.
 */
function buildApp(logLevel) {
  // الإعدادات بعد التحقق منها: يفشل هنا إن نقص متغير أو كان سر ضعيفاً.
  const config = loadConfig();
  const app = createCommerceApp({
    databaseUrl: config.databaseUrl,
    ownerApiKey: config.ownerApiKey,
    authTokenSecret: config.authTokenSecret,
    corsOrigin: config.corsOrigin,
    trustProxy: config.trustProxy,
    logger: new Logger(logLevel ?? config.logLevel),
    accessControl: new AccessControl(ROLES),
    // إضافات الإطار الثلاث التي اختارها هذا المتجر، ثم إضافات المتجر نفسه. متجر آخر يختار غيرها،
    // دون تعديل الإطار. الترتيب مهم: staffAccounts قبل courierDelivery، لأن التوصيل يطلب
    // مستودع الموظفين من الحاوية (والإطار يهيئ الإضافات بترتيبها هنا).
    plugins: [
      cityRateShipping({ name: "توصيل للمنزل", rates: DELIVERY_RATES, freeOver: 500000 }), // مجاني فوق 500 دينار
      flatRateShipping({ id: "pickup", name: "استلام من المحل - تاجوراء", rate: 0 }),
      cashOnDelivery({
        name: "الدفع نقداً عند الاستلام",
        instructions: "ادفع نقداً للمندوب عند استلام طلبك، أو في المحل إن اخترت الاستلام من المحل.",
      }),
      // توكن الموظف موقّع بنفس سر الإطار، فتقبله مصادقة الإطار في كل المسارات.
      staffAccounts({ tokenSecret: config.authTokenSecret }),
      courierDelivery({ cashPaymentMethods: ["cod"] }),
      customerOrders(),
      storeReports(),
    ],
  });
  return { app, config };
}

module.exports = { buildApp, ROLES };
