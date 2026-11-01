# خريطة المشروع: أين أجد…؟

هذا الدليل يوجّهك إلى الملف الصحيح مباشرة. للبحث داخل الملفات في VS Code:

| الغرض | الاختصار |
|---|---|
| فتح ملف باسمه | `Ctrl + P` |
| البحث عن كلمة في كل المشروع | `Ctrl + Shift + F` |
| الانتقال إلى دالة داخل الملف المفتوح | `Ctrl + Shift + O` |

## المجلدات الرئيسية

| المجلد أو الملف | ما فيه |
|---|---|
| `src/` | كود الإطار نفسه (TypeScript)، واسم الحزمة `maa` |
| `src/engine/` | النواة: HTTP، والتوجيه، والتحقق، والأخطاء، والأمان، والمقاييس، وتوليد OpenAPI |
| `src/middleware/` | المعالجات الوسيطة: CORS، وترويسات الأمان، والمصادقة، وتسجيل الطلبات، والتحقق، والمقاييس، وسجل التدقيق، وIdempotency-Key |
| `src/container/` | حقن الاعتماديات (Dependency Injection) |
| `src/db/` | طبقة قاعدة البيانات: الاتصال، والـ Repository، والـ Migrations، والـ Transactions، وترجمة أخطاء PostgreSQL |
| `src/runtime/` | ما يحتاجه الإطار ليعمل على أكثر من نسخة خادم دون Redis: الجلسات، وحد المحاولات، ومفاتيح Idempotency، وسجل التدقيق، وصندوق الصادر، وطابور المهام، والعامل في الخلفية، والإيقاف اللطيف |
| `src/modules/` | موديولات التجارة الثمانية؛ كل موديول في مجلد |
| `src/plugins/` | الإضافات الجاهزة: الدفع والشحن والكوبونات والضريبة |
| `tests/` | الاختبارات: `unit/` للوحدات، و`integration/` للتكامل مع قاعدة البيانات |
| `cli/` | أداة سطر الأوامر `maa` (الأمر `create`) وقوالب المشروع الجديد |
| `examples/demo-store/` | Demo E-Commerce API: مثال يستخدم الإطار كمكتبة |
| `examples/plugins/` | إضافات "طرف ثالث" تستخدم الواجهة العامة فقط (بوابة دفع مستضافة، واستبدال خدمة عبر الحاوية) |
| `storefront/` | متجر ماء (Maa Store): خادم المتجر (`api/`) وإضافاته (`api/plugins/`)، والموقع (`web/`) ومعه لوحة الإدارة وتطبيق المندوب |
| `bench/` | قياس الأداء |
| `scripts/` | `verify.js` (الفحص الشامل)، و`setup-env.js`، و`lint.js` (قواعد الكود)، و`openapi.js` (توليد `docs/openapi.json`) |
| `Dockerfile`، `docker-compose.yml`، `.dockerignore` | صورة الإنتاج، وتشغيل كامل محلياً (PostgreSQL ثم migrate ثم الـ API) |
| `.github/workflows/ci.yml` | CI: lint، والبناء، وفحص OpenAPI، والاختبارات مع حد التغطية، وفحص الاعتماديات، و`verify`، وبناء صورة Docker |
| `docs/` | الأدلة (هذا الملف منها) |
| `documents/` | المقترح والتقرير والعروض: **على جهازك فقط، لا تُرفع إلى GitHub** |

المجلدات `dist/` و`build-test/` و`node_modules/` تُولَّد تلقائياً. لا تعدّل فيها ولا تبحث فيها.

## نواة الإطار: أين كل ميزة

| الميزة | الملف |
|---|---|
| HTTP Request/Response layer | `src/engine/http/server.ts`، `request.ts`، `response.ts`، و`client-ip.ts` (عنوان العميل خلف proxy) |
| رقم الطلب `X-Request-Id`، وحد حجم الجسم (413)، و405 مع `Allow` | `src/engine/http/server.ts` |
| Routing System (REST)، وHEAD، والمسار المكرر | `src/engine/router.ts` |
| بطاقة المسار (المصادقة والصلاحية والـ schema لكل مسار) | `src/engine/route-meta.ts` |
| Middleware Pipeline | `src/engine/middleware-pipeline.ts` |
| Dependency Injection | `src/container/container.ts`، و`tokens.ts` (أسماء الخدمات) |
| Validation (الجسم والاستعلام ومتغيرات المسار، وnullable) | `src/engine/validation.ts`، و`src/middleware/validate.ts` (`withInput`) |
| Centralized Error Handling ورموز الأخطاء (`ErrorCodes`) | `src/engine/errors.ts`، و`src/db/errors.ts` (أخطاء PostgreSQL) |
| Authentication (مفتاح المالك، وتوكن الزبون والموظف) | `src/middleware/auth.ts`، و`src/engine/auth-token.ts` (التوكن)، و`src/engine/password.ts` (تشفير كلمات المرور) |
| الجلسات في الخادم (الخروج، والخروج من كل الأجهزة) | `src/runtime/sessions.ts` |
| Authorization (Roles/Permissions، `DEFAULT_ROLES`) | `src/engine/access-control.ts` |
| حدّ المحاولات (Rate limiting) | `src/engine/rate-limiter.ts` (في الذاكرة)، و`src/runtime/rate-limit.ts` (في PostgreSQL، الافتراضي) |
| منع التكرار (`Idempotency-Key`) | `src/middleware/idempotency.ts`، و`src/runtime/idempotency.ts` (التخزين) |
| التعديل المتفائل (`ETag` و`If-Match`) | `src/modules/shared.ts` (`etag`، `expectedVersion`)، و`src/db/repository.ts` |
| الترقيم و`X-Total-Count` | `src/modules/shared.ts` (`PAGINATION_QUERY`، `sendPage`) |
| ترويسات الأمان | `src/middleware/security-headers.ts` |
| CORS | `src/middleware/cors.ts` |
| Logging | `src/engine/logger.ts`، و`src/middleware/request-logger.ts` |
| المقاييس (Prometheus، `GET /metrics`) | `src/engine/metrics.ts`، و`src/middleware/metrics.ts` |
| سجل التدقيق (`GET /audit-log`) | `src/middleware/audit.ts`، و`src/runtime/audit-log.ts` |
| صندوق الصادر (الأحداث بعد COMMIT) | `src/runtime/outbox.ts` |
| طابور المهام والمهام الدورية | `src/runtime/jobs.ts`، و`src/runtime/worker.ts` (العامل في الخلفية) |
| الإيقاف اللطيف (SIGTERM و Ctrl+C) | `src/runtime/lifecycle.ts` (`installShutdownHandlers`) |
| توقيع الـ webhooks والتحقق منها | `src/engine/webhook.ts` |
| توليد OpenAPI | `src/engine/openapi.ts`، و`scripts/openapi.js` |
| Configuration Management | `src/engine/config.ts` |
| Database Abstraction + Repository | `src/db/repository.ts`، و`src/db/connection.ts` |
| Migrations | `src/db/migrations.ts`، و`src/runtime/migrations.ts` (جداول وقت التشغيل) |
| Transactions (مع إعادة المحاولة عند deadlock) | `src/db/transaction.ts` |
| Plugin/Extension System (الشحن والدفع ومعدّلات السعر والأحداث) | `src/modules/extensions.ts` |
| نقطة البداية: تجميع كل شيء، ومسارات النظام | `src/app.ts` (`createCommerceApp`، `optionsFromConfig`) |
| ما يُصدَّر للمستخدمين (`require("maa")`) | `src/index.ts` |
| خادم التطوير، وأمر migrate | `src/dev-server.ts`، و`src/migrate.ts` |
| CLI | `cli/index.js`، و`cli/templates/` |

**مسارات النظام** في `src/app.ts`: `GET /health`، و`/livez`، و`/readyz`، و`/metrics`، و`/openapi.json` (من الجذر دائماً)، و`GET /audit-log`.

## الموديولات الثمانية

كل موديول له الملفات نفسها:
- `index.ts`: المسارات والصلاحيات.
- `*.repository.ts`: استعلامات SQL.
- `*.schema.ts`: الجداول (Migrations) وقواعد التحقق وشكل البيانات.

تُسجَّل بترتيب الاعتماد في `src/modules/index.ts`. الأدوات المشتركة في `src/modules/shared.ts`، وعقد الموديول (`CommerceModule` و`ModuleContext`) في `src/modules/types.ts`.

| الموديول | المجلد | المسارات |
|---|---|---|
| Categories | `src/modules/categories/` | `GET/POST /categories`، `GET/PATCH/DELETE /categories/:id` |
| Products | `src/modules/products/` | `GET/POST /products`، `GET /products/by-slug/:slug`، `GET/PATCH/DELETE /products/:id`، `GET/POST /products/:id/variants`، `PATCH/DELETE /products/:id/variants/:variantId` |
| Inventory | `src/modules/inventory/` | `GET/PUT /inventory/:productId`، `POST /inventory/:productId/adjust`، `PUT /inventory/variants/:variantId`، `POST /inventory/variants/:variantId/adjust` |
| Customers | `src/modules/customers/` | `POST /customers/register`، `/login`، `/logout`، `/logout-all`، `GET/PATCH /customers/me`، `GET /customers/me/sessions`، `POST /customers/me/password`، `POST /customers/password-reset`، `POST /customers/password-reset/confirm`، `GET /customers`، `GET /customers/:id` |
| Staff | `src/modules/staff/` | `POST /staff/login`، `POST /staff/logout`، `GET /staff/me`، `POST /staff/me/password`، `GET /staff/roles`، `GET/POST /staff`، `GET/PATCH /staff/:id` |
| Cart | `src/modules/cart/` (+ `cart.access.ts` لملكية السلة) | `POST /carts`، `GET /carts/mine`، `GET /carts/:id`، `POST /carts/:id/items`، `PUT/DELETE /carts/:id/items/:productId` |
| Orders | `src/modules/orders/` (+ `orders.service.ts` لمنطق الشراء والدفع والاسترجاع، و`orders.timeline.ts` للسجل الزمني) | `POST/GET /orders`، `GET /orders/:id`، `GET /orders/:id/events`، `PATCH /orders/:id/status`، `PATCH /orders/:id/payment`، `POST/GET /orders/:id/refunds`، `GET /checkout/options`، `POST /checkout/quote` |
| Delivery | `src/modules/delivery/` (+ `delivery.service.ts` لمنطق الإسناد والاستلام والتسليم) | `POST/GET /orders/:id/delivery`، `GET /deliveries`، `POST /deliveries/:orderId/pickup`، `/deliver`، `/fail` |

تفاصيل كل مسار (المدخلات والمخرجات والأخطاء) في `docs/API.md`، والوصف الآلي الكامل في `docs/openapi.json`.

**المهام الدورية:** `orders.releaseExpiredHolds` كل دقيقة (إلغاء الطلبات التي انتهت مهلة دفعها) في `src/modules/orders/index.ts`، و`cart.cleanupAbandoned` يومياً (سلال الضيوف المتروكة) في `src/modules/cart/index.ts`، و`system.cleanup` كل ساعة (جداول وقت التشغيل) في `src/app.ts`.

## جداول قاعدة البيانات

تعريفاتها في ملفات `*.schema.ts`، وجداول وقت التشغيل في `src/runtime/migrations.ts`، وجداول الإضافات داخل الإضافة نفسها. تُطبَّق حسب رقمها (`npm run migrate`):

| الرقم | الجدول أو التعديل | الملف |
|---|---|---|
| 0100 | `categories` | `categories.schema.ts` |
| 0200 | `products` | `products.schema.ts` |
| 0300 | `inventory` | `inventory.schema.ts` |
| 0400 | `customers` | `customers.schema.ts` |
| 0500 | `carts` و`cart_items` | `cart.schema.ts` |
| 0600 | `orders` و`order_items` | `orders.schema.ts` |
| 0700 | الشحن والدفع في الطلب | `orders.schema.ts` |
| 0800 | صورة المنتج | `products.schema.ts` |
| 0810 | مدينة التوصيل | `orders.schema.ts` |
| 0900 | جداول وقت التشغيل: `idempotency_keys`، `outbox_events`، `jobs`، `rate_limits`، `auth_sessions`، `audit_log` | `src/runtime/migrations.ts` |
| 0910، 0911 | المبالغ BIGINT (المنتجات والطلبات) | `products.schema.ts`، `orders.schema.ts` |
| 0920 | العملة وتعديلات السعر في الطلب (`currency`، `adjustments`)، وقيود الحساب | `orders.schema.ts` |
| 0930، 0931 | رقم النسخة `version` للأقسام والمنتجات (ETag) | `categories.schema.ts`، `products.schema.ts` |
| 0940 | `product_variants` (الأشكال) | `products.schema.ts` |
| 0945 | `variant_inventory` (مخزون الأشكال) | `inventory.schema.ts` |
| 0950 | الشكل في سطر السلة | `cart.schema.ts` |
| 0955 | الشكل في سطر الطلب | `orders.schema.ts` |
| 0960 | مهلة الدفع، والمسترجع، و`refunds` | `orders.schema.ts` |
| 0970 | `order_events` (السجل الزمني) | `orders.schema.ts` |
| 0975 | `password_resets` | `customers.schema.ts` |
| 0980 | `staff` | `staff.schema.ts` |
| 0990 | `order_deliveries` | `delivery.schema.ts` |
| 1100 | `coupons` و`coupon_redemptions` (فقط إن ثُبّتت الإضافة) | `src/plugins/coupons.ts` |

## الإضافات (Plugins)

| الإضافة | الملف |
|---|---|
| الدفع عند الاستلام | `src/plugins/cash-on-delivery.ts` |
| شحن بسعر ثابت (ومنه الاستلام من المحل) | `src/plugins/flat-rate-shipping.ts` |
| شحن حسب المدينة | `src/plugins/city-rate-shipping.ts` |
| الكوبونات (جداولها ومسارات `/coupons` ومعدّل السعر) | `src/plugins/coupons.ts` |
| ضريبة بنسبة ثابتة | `src/plugins/percentage-tax.ts` |
| تصدير الإضافات | `src/plugins/index.ts` |

**أمثلة إضافات خارجية** (`examples/plugins/`، تستورد من الواجهة العامة فقط، ويفحص ذلك `npm run lint`):

| المثال | الملف |
|---|---|
| بوابة دفع مستضافة: تحويل لصفحة الدفع، وwebhook موقّع، ومهلة دفع، واسترجاع | `examples/plugins/hosted-gateway.ts` |
| استبدال مستودع المنتجات عبر الحاوية بنسخة فيها ذاكرة مؤقتة | `examples/plugins/cached-products.ts` |
| يقوم مقام `require("maa")` داخل المستودع | `examples/plugins/maa.ts` |

## متجر ماء (`storefront/`)

| أريد أن… | الملف |
|---|---|
| أغيّر المدن وأسعار التوصيل، أو الإضافات المثبتة | `storefront/api/app.js` (`DELIVERY_RATES` وقائمة `plugins`) |
| أغيّر المنتجات أو الأشكال أو الكوبونات التجريبية | `storefront/api/seed.js` (`CATALOGUE`، `VARIANTS`، `COUPONS`) |
| أغيّر حسابات الموظفين التجريبية | `storefront/api/seed.js` (`STAFF`) |
| أعدّل بوابة البطاقة التجريبية (رابط الدفع، والـ webhook، والمهلة) | `storefront/api/plugins/demo-card-gateway.js` |
| أعدّل رسائل صندوق بريد التطوير (استعادة كلمة المرور، وإشعارات الطلب والتوصيل) | `storefront/api/plugins/dev-mailbox.js` |
| أفعّل أو أطفئ وضع التجربة | `storefront/.env` (`DEMO_MODE`) |
| أغيّر اسم المتجر أو العنوان أو رقم واتساب | `storefront/web/js/config.js` |
| أغيّر الألوان والتصميم | `storefront/web/css/styles.css`، و`storefront/web/css/app.css` (لوحة الإدارة وتطبيق المندوب) |
| أعدّل صفحة في موقع الزبون | `storefront/web/<الصفحة>.html` وسكربتها في `storefront/web/js/pages/<الصفحة>.js` |
| أعدّل صفحة الدفع التجريبية أو صفحة كلمة المرور الجديدة | `web/pay.html` و`js/pages/pay.js`، و`web/reset.html` و`js/pages/reset.js` |
| أعدّل عرض الطلب (المراحل، والسجل الزمني، والمندوب) في "طلباتي" والتتبع | `storefront/web/js/order-view.js` |
| أعدّل لوحة الإدارة | `storefront/web/admin.html`، و`js/staff/admin.js` (الأقسام، والكوبونات، والزبائن، والموظفون، والتدقيق)، و`js/staff/admin-orders.js` (الطلبات والإسناد والاسترجاع)، و`js/staff/admin-catalog.js` (المنتجات والأشكال والمخزون والأقسام) |
| أعدّل تطبيق المندوب | `storefront/web/courier.html`، و`js/staff/courier.js` |
| أعدّل دخول الموظفين والصلاحيات في الواجهة | `storefront/web/js/staff/common.js` |
| أعدّل الاتصال بالـ API | `storefront/web/js/api.js` |
| أعدّل ما يُحفظ في المتصفح (السلة والجلسات) | `storefront/web/js/store.js` |
| أعدّل العناصر المشتركة (الرأس، والسلة، والرسائل، وترجمة الأخطاء) | `storefront/web/js/ui.js` |
| أعدّل سياسة الأمان (CSP) | `storefront/web-server.js` |
| أضيف صور منتجات | `storefront/web/images/products/` |

## الاختبارات: أين يُختبر كل شيء

| الموضوع | الملف |
|---|---|
| التحقق من المدخلات | `tests/unit/validation.test.ts`، و`tests/unit/validation-v2.test.ts` (الكائنات المتداخلة، وnullable، والاستعلام، وfuzz) |
| الصلاحيات | `tests/unit/access-control.test.ts` |
| التوجيه | `tests/unit/router.test.ts`، و`tests/unit/router-v2.test.ts` (HEAD، والترميز المعطوب، والمسار المكرر، وبطاقة المسار) |
| كلمات المرور والتوكن | `tests/unit/auth-crypto.test.ts` |
| حدّ المحاولات | `tests/unit/rate-limiter.test.ts`، و`tests/integration/login-rate-limit.test.ts`، و`registration-rate-limit.test.ts` |
| قطع وقت التشغيل: السجل، والمقاييس، وتوقيع الـ webhooks، والتوكنات، والإعدادات، وOpenAPI، والإيقاف | `tests/unit/runtime-pieces.test.ts` |
| المنتجات والأقسام | `tests/integration/catalog.test.ts` |
| المخزون | `tests/integration/inventory.test.ts` |
| الزبائن | `tests/integration/customers.test.ts` |
| السلة والطلبات | `tests/integration/cart-orders.test.ts` |
| الإضافات | `tests/integration/plugins.test.ts` |
| CORS | `tests/integration/cors.test.ts` |
| ميزات المتجر (الصور، والمدن) | `tests/integration/storefront-features.test.ts` |
| عقد HTTP: 413، و405، و`X-Request-Id`، وترويسات الأمان، وnull في PATCH، وETag/If-Match، و`X-Total-Count`، وآلة حالات الدفع، وIdempotency-Key، وbasePath، وOpenAPI | `tests/integration/hardening.test.ts` |
| الشراء المتزامن: لا أخطاء 500، ولا بيع أكثر من المخزون، والإلغاء المتزامن | `tests/integration/concurrency.test.ts` |
| الأمان: الخروج، والجلسات، وتغيير كلمة المرور واستعادتها، وأدوار الموظفين، وسجل التدقيق، وتغيير الأسرار | `tests/integration/security.test.ts` |
| التشغيل: `/livez` و`/readyz`، والمقاييس، والسجل، وصندوق الصادر، والمهام، والإيقاف اللطيف | `tests/integration/operations.test.ts` |
| نسختان من الخادم على قاعدة واحدة | `tests/integration/multi-instance.test.ts` |
| التجارة: الأشكال، ودمج السلة، والكوبونات والضريبة، ومهلة الدفع، والاسترجاع، والتوصيل | `tests/integration/commerce-v2.test.ts` |
| إضافات طرف ثالث (`examples/plugins`)، وعقد الإضافة ودورة حياتها | `tests/integration/third-party.test.ts` |
| الموقع ولوحة الإدارة وتطبيق المندوب في متصفح حقيقي | `storefront/tests/browser.mjs` (`npm run test:browser`) |
| قواعد الكود (حدود الطبقات، ولا `any`، ولا `console`) | `scripts/lint.js` (`npm run lint`) |
| `docs/openapi.json` محدّث | `scripts/openapi.js` (`npm run openapi:check`) |
| الفحص الشامل لكل شيء | `scripts/verify.js` (`npm run verify`)، و`npm run check` (lint، والبناء، وOpenAPI، والاختبارات مع التغطية) |
| أداة الاختبار المشتركة | `tests/helpers/test-app.ts` |

## الأدلة

| الدليل | الملف |
|---|---|
| نظرة عامة (بالإنجليزية) | `README.md` |
| المعمارية (بالإنجليزية) | `docs/ARCHITECTURE.md` |
| كتابة الإضافات (بالإنجليزية) | `docs/EXTENDING.md` |
| كل ميزة بمثال (بالإنجليزية) | `docs/EXAMPLES.md` |
| خارطة الطريق (بالإنجليزية) | `docs/ROADMAP.md` |
| خطة فهم ومراجعة المشروع للفريق | `docs/STUDY-PLAN.md` |
| توزيع المشروع على الفريق (من يملك ماذا) | `docs/TEAM-ROLES.md` |
| التثبيت على Windows | `docs/SETUP.md` |
| التثبيت على Linux | `docs/SETUP-LINUX.md` |
| كل مسارات الـ API | `docs/API.md`، و`docs/openapi.json` (يُولَّد بـ `npm run openapi`) |
| نتائج الأداء | `docs/PERFORMANCE.md` |
| تشغيل متجر ماء | `storefront/README.md` |
| تشغيل Demo API | `examples/demo-store/README.md` |
