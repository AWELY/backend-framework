# خريطة المشروع: أين أجد…؟

هذا الدليل يوجّهك إلى الملف الصحيح مباشرة. للبحث داخل الملفات في VS Code:

| الغرض | الاختصار |
|---|---|
| فتح ملف باسمه | `Ctrl + P` |
| البحث عن كلمة في كل المشروع | `Ctrl + Shift + F` |
| الانتقال إلى دالة داخل الملف المفتوح | `Ctrl + Shift + O` |

## المجلدات الرئيسية

| المجلد | ما فيه |
|---|---|
| `src/` | كود الإطار نفسه (TypeScript) |
| `src/engine/` | النواة: HTTP، والتوجيه، والتحقق، والأخطاء، والأمان |
| `src/middleware/` | المعالجات الوسيطة: CORS، والمصادقة، وتسجيل الطلبات، والتحقق |
| `src/container/` | حقن الاعتماديات (Dependency Injection) |
| `src/db/` | طبقة قاعدة البيانات: الاتصال، والـ Repository، والـ Migrations، والـ Transactions |
| `src/modules/` | موديولات التجارة الستة؛ كل موديول في مجلد |
| `src/plugins/` | الإضافات الجاهزة: الدفع والشحن |
| `tests/` | الاختبارات: `unit/` للوحدات، و`integration/` للتكامل مع قاعدة البيانات |
| `cli/` | أداة سطر الأوامر `create` وقوالب المشروع الجديد |
| `examples/demo-store/` | Demo E-Commerce API: مثال يستخدم الإطار كمكتبة |
| `storefront/` | متجر AMA: خادم المتجر (`api/`) والموقع (`web/`) |
| `bench/` | قياس الأداء |
| `scripts/` | `verify.js` (الفحص الشامل) و`setup-env.js` |
| `docs/` | الأدلة (هذا الملف منها) |
| `documents/` | المقترح والتقرير والعروض: **على جهازك فقط، لا تُرفع إلى GitHub** |

المجلدات `dist/` و`build-test/` و`node_modules/` تُولَّد تلقائياً. لا تعدّل فيها ولا تبحث فيها.

## نواة الإطار: أين كل ميزة من المقترح

| الميزة في المقترح | الملف |
|---|---|
| HTTP Request/Response layer | `src/engine/http/server.ts`، `request.ts`، `response.ts` |
| Routing System (REST) | `src/engine/router.ts` |
| Middleware Pipeline | `src/engine/middleware-pipeline.ts` |
| Dependency Injection | `src/container/container.ts`، و`tokens.ts` (أسماء الخدمات) |
| Validation | `src/engine/validation.ts`، و`src/middleware/validate.ts` |
| Centralized Error Handling | `src/engine/errors.ts` |
| Authentication | `src/middleware/auth.ts`، و`src/engine/auth-token.ts` (التوكن)، و`src/engine/password.ts` (تشفير كلمات المرور) |
| Authorization (Roles/Permissions) | `src/engine/access-control.ts` |
| حدّ المحاولات (Rate limiting) | `src/engine/rate-limiter.ts` |
| Logging | `src/engine/logger.ts`، و`src/middleware/request-logger.ts` |
| Configuration Management | `src/engine/config.ts` |
| CORS | `src/middleware/cors.ts` |
| Database Abstraction + Repository | `src/db/repository.ts`، و`src/db/connection.ts` |
| Migrations | `src/db/migrations.ts` |
| Transactions | `src/db/transaction.ts` |
| Plugin/Extension System | `src/modules/extensions.ts` |
| نقطة البداية: تجميع كل شيء | `src/app.ts` (`createCommerceApp`) |
| ما يُصدَّر للمستخدمين | `src/index.ts` |
| CLI | `cli/index.js`، و`cli/templates/` |

## الموديولات الستة

كل موديول له الملفات نفسها:
- `index.ts`: المسارات والصلاحيات.
- `*.repository.ts`: استعلامات SQL.
- `*.schema.ts`: الجدول (Migration) وقواعد التحقق.

| الموديول | المجلد | المسارات |
|---|---|---|
| Categories | `src/modules/categories/` | `GET/POST /categories`، `GET/PATCH/DELETE /categories/:id` |
| Products | `src/modules/products/` | `GET/POST /products`، `GET/PATCH/DELETE /products/:id` |
| Inventory | `src/modules/inventory/` | `GET/PUT /inventory/:productId`، `POST /inventory/:productId/adjust` |
| Customers | `src/modules/customers/` | `POST /customers/register`، `POST /customers/login`، `GET/PATCH /customers/me`، `GET /customers`، `GET /customers/:id` |
| Cart | `src/modules/cart/` (+ `cart.access.ts` لملكية السلة) | `POST /carts`، `GET /carts/:id`، `POST /carts/:id/items`، `PUT/DELETE /carts/:id/items/:productId` |
| Orders | `src/modules/orders/` (+ `orders.service.ts` لمنطق إتمام الطلب) | `POST/GET /orders`، `GET /orders/:id`، `PATCH /orders/:id/status`، `PATCH /orders/:id/payment`، `GET /checkout/options`، `POST /checkout/quote` |

تفاصيل كل مسار (المدخلات والمخرجات والأخطاء) في `docs/API.md`.

**جداول قاعدة البيانات:** تعريفاتها في ملفات `*.schema.ts`. تُطبَّق حسب رقمها:

| الرقم | الجدول أو التعديل |
|---|---|
| 0100 | categories |
| 0200 | products |
| 0300 | inventory |
| 0400 | customers |
| 0500 | carts |
| 0600 | orders |
| 0700 | الشحن والدفع في الطلب |
| 0800 | صورة المنتج |
| 0810 | مدينة التوصيل |

## الإضافات (Plugins)

| الإضافة | الملف |
|---|---|
| الدفع عند الاستلام | `src/plugins/cash-on-delivery.ts` |
| شحن بسعر ثابت (ومنه الاستلام من المحل) | `src/plugins/flat-rate-shipping.ts` |
| شحن حسب المدينة | `src/plugins/city-rate-shipping.ts` |

## متجر AMA (`storefront/`)

| أريد أن… | الملف |
|---|---|
| أغيّر المدن وأسعار التوصيل | `storefront/api/app.js` (`DELIVERY_RATES`) |
| أغيّر المنتجات التجريبية | `storefront/api/seed.js` |
| أغيّر اسم المتجر أو العنوان أو رقم واتساب | `storefront/web/js/config.js` |
| أغيّر الألوان والتصميم | `storefront/web/css/styles.css` |
| أعدّل صفحة معيّنة | `storefront/web/<الصفحة>.html` وسكربتها في `storefront/web/js/pages/<الصفحة>.js` |
| أعدّل الاتصال بالـ API | `storefront/web/js/api.js` |
| أعدّل العناصر المشتركة (الرأس، والسلة، والرسائل، وترجمة الأخطاء) | `storefront/web/js/ui.js` |
| أعدّل سياسة الأمان (CSP) | `storefront/web-server.js` |
| أضيف صور منتجات | `storefront/web/images/products/` |

## الاختبارات: أين يُختبر كل شيء

| الموضوع | الملف |
|---|---|
| التحقق من المدخلات | `tests/unit/validation.test.ts` |
| الصلاحيات | `tests/unit/access-control.test.ts` |
| التوجيه | `tests/unit/router.test.ts` |
| كلمات المرور والتوكن | `tests/unit/auth-crypto.test.ts` |
| حدّ المحاولات | `tests/unit/rate-limiter.test.ts`، و`tests/integration/login-rate-limit.test.ts`، و`registration-rate-limit.test.ts` |
| المنتجات والأقسام | `tests/integration/catalog.test.ts` |
| المخزون | `tests/integration/inventory.test.ts` |
| الزبائن | `tests/integration/customers.test.ts` |
| السلة والطلبات | `tests/integration/cart-orders.test.ts` |
| الإضافات | `tests/integration/plugins.test.ts` |
| CORS | `tests/integration/cors.test.ts` |
| ميزات المتجر (الصور، والمدن) | `tests/integration/storefront-features.test.ts` |
| الموقع في متصفح حقيقي | `storefront/tests/browser.mjs` |
| الفحص الشامل لكل شيء | `scripts/verify.js` (`npm run verify`) |
| أداة الاختبار المشتركة | `tests/helpers/test-app.ts` |

## الأدلة

| الدليل | الملف |
|---|---|
| نظرة عامة (بالإنجليزية) | `README.md` |
| خطة فهم ومراجعة المشروع للفريق | `docs/STUDY-PLAN.md` |
| توزيع المشروع على الفريق (من يملك ماذا) | `docs/TEAM-ROLES.md` |
| التثبيت على Windows | `docs/SETUP.md` |
| التثبيت على Linux | `docs/SETUP-LINUX.md` |
| كل مسارات الـ API | `docs/API.md` |
| نتائج الأداء | `docs/PERFORMANCE.md` |
| تشغيل متجر AMA | `storefront/README.md` |
| تشغيل Demo API | `examples/demo-store/README.md` |
