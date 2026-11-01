# عقد الـ API (API Contract)

هذا المرجع موجَّه لمن يبني واجهة فوق إطار **Maa** (موقع، أو تطبيق جوال، أو لوحة إدارة، أو تطبيق مندوب). كل المسارات تُرجع JSON.

**المصدر الآلي الكامل:** `docs/openapi.json` (OpenAPI 3.1، 73 عملية)، ويقدّمه الخادم نفسه أيضاً على `GET /openapi.json`. يُولَّد من الـ schemas الحقيقية للمسارات (`npm run openapi`)، وCI يرفض أي فرق بينه وبين الكود (`npm run openapi:check`). فيه شكل كل جسم طلب واستعلام، والمصادقة، والصلاحية المطلوبة، والترويسات. هذا الملف يشرح ما لا يصفه OpenAPI: أشكال الردود، والقواعد، والأخطاء.

## قواعد عامة

| البند | القاعدة |
|---|---|
| صيغة الطلب | `Content-Type: application/json` لأي طلب له body. الحد الأقصى للجسم 1 ميغابايت افتراضياً (`BODY_LIMIT_BYTES`)، وأكبر منه: 413 |
| المبالغ | أعداد صحيحة **بأصغر وحدة للعملة**: للدينار الليبي الدرهم (`1 LYD = 1000`). مثال: `15000` = 15 د.ل. العملة الافتراضية `LYD` (الإعداد `CURRENCY`)، وتظهر في `currency` في الطلب والتسعير و`/checkout/options` |
| المعرّفات | UUID. معرّف بصيغة خاطئة في المسار يُعامَل كغير موجود (404) |
| الحقول | أسماء camelCase. أي حقل غير معرّف في **الجسم** يُرفض بـ 400. المفاتيح غير المعروفة في **الاستعلام** تُتجاهل (مثل `utm_source`) |
| PATCH | يعدّل الحقول المرسلة فقط. الحقل القابل للمسح (nullable) يقبل `null` بمعنى "امسح القيمة"، مثل `"description": null` أو `"phone": null` |
| التواريخ | نصوص ISO 8601 بتوقيت UTC، مثل `"2026-11-02T10:15:00.000Z"` |
| بادئة النسخة | `API_BASE_PATH` (مثل `/v1`) تضع كل مسارات الـ API تحتها. مسارات النظام (`/health` و`/livez` و`/readyz` و`/metrics` و`/openapi.json`) تبقى من الجذر دائماً |
| CORS | مفعّل، والمصادر المسموحة تُضبط بـ `CORS_ORIGIN` (واحد، أو عدة مصادر مفصولة بفواصل، أو `*`) |

## الترويسات

**يرسلها العميل:**

| الترويسة | متى |
|---|---|
| `X-Api-Key: <OWNER_API_KEY>` | المالك (وأدوات الأتمتة) |
| `Authorization: Bearer <token>` | زبون أو موظف، بالتوكن من الدخول |
| `Idempotency-Key: <مفتاح عشوائي>` | اختيارية في `POST /orders` و`POST /orders/:id/refunds`. 1–255 حرفاً من `A-Z a-z 0-9 - _ : .` |
| `If-Match: "<version>"` | اختيارية في `PATCH`/`DELETE` على المنتجات والأقسام (التعديل المتفائل) |
| `X-Request-Id` | اختيارية. إن أرسلها العميل أو الـ proxy بصيغة صالحة (1–128 حرفاً من `A-Z a-z 0-9 . _ : -`) تُستخدم كرقم للطلب، وإلا يولّد الخادم UUID |

**يرسلها الخادم:**

| الترويسة | متى |
|---|---|
| `X-Request-Id` | **مع كل رد**، ناجحاً كان أو خطأ. نفس القيمة في `error.requestId` وفي سجل الخادم، فاذكرها عند الإبلاغ عن مشكلة |
| `X-Total-Count` | مع كل قائمة مرقّمة: العدد الكلي قبل `limit`/`offset` |
| `ETag: "<version>"` | مع قراءة أو إنشاء أو تعديل منتج أو قسم |
| `Idempotency-Replayed: true` | الرد معاد من طلب سابق بنفس `Idempotency-Key` |
| `Retry-After` | مع 429 و503: بعد كم ثانية تعيد المحاولة |
| `Allow` | مع 405: الطرق المسموحة على هذا المسار |
| ترويسات أمان | `X-Content-Type-Options: nosniff`، و`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`، و`X-Frame-Options: DENY`، و`Referrer-Policy: no-referrer` على كل رد. و`Cache-Control: no-store` على كل رد لطلب يحمل مصادقة. و`Strict-Transport-Security` إن فُعّل الخيار `hsts` (خلف HTTPS فقط) |

CORS يسمح للمتصفح بإرسال `Content-Type, Authorization, X-Api-Key, Idempotency-Key, If-Match, X-Request-Id`، وبقراءة `X-Request-Id, X-Total-Count, ETag, Retry-After, Idempotency-Replayed` من الرد.

## الترقيم (Pagination)

| البند | القاعدة |
|---|---|
| المعاملات | `?limit=` (1–100، الافتراضي 50) و`?offset=` (0 فأكثر، الافتراضي 0) |
| قيمة غير صالحة | **400** `VALIDATION_FAILED`، مثل `{ "field": "query.limit", "message": "must be <= 100" }`. لا تُستبدل بصمت بالقيمة الافتراضية |
| شكل الرد | **مصفوفة JSON** كما كان دائماً، والعدد الكلي في ترويسة `X-Total-Count` |
| القوائم المرقّمة | `/categories`، `/products`، `/customers`، `/staff`، `/orders`، `/deliveries`، `/coupons`، `/audit-log` |
| قوائم كاملة بلا ترقيم | أشكال المنتج، واسترجاعات الطلب، وسجل الطلب الزمني، وجلسات الزبون |

## شكل الخطأ (موحّد في كل المسارات)

```json
{ "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [ { "field": "price", "message": "must be >= 0" } ],
    "requestId": "3f0c9a52-6b1e-4f7e-9d0a-2b8f1c7e4a11" } }
```

- **`code`** عقد ثابت تقرؤه البرامج (`if (error.code === "INSUFFICIENT_STOCK")`)، و**`message`** للبشر وقد تتغير صياغتها. القائمة الكاملة في `ErrorCodes` (`src/engine/errors.ts`).
- **`details`** موجود دائماً (`null` إن لم توجد تفاصيل). في أخطاء التحقق يسرد **كل** الحقول المخالفة دفعة واحدة، بأسماء مثل `price` أو `query.limit` أو `params.id` أو `restock[0].quantity`.
- الإضافات تستطيع إصدار رموزها بنفس الشكل، مثل `INVALID_COUPON` من إضافة الكوبونات.

| الحالة | الرموز | المعنى |
|---|---|---|
| 400 | `VALIDATION_FAILED`، `MALFORMED_JSON`، `MALFORMED_URL`، `REFERENCE_NOT_FOUND`، `CART_EMPTY`، `VARIANT_REQUIRED`، `INVALID_RESET_TOKEN`، `INVALID_CREDENTIALS` (كلمة المرور الحالية خاطئة)، `INVALID_COUPON` | مدخلات غير صالحة |
| 401 | `UNAUTHORIZED`، `INVALID_CREDENTIALS`، `INVALID_TOKEN`، `INVALID_API_KEY` | لا بيانات دخول، أو بيانات خاطئة، أو جلسة منتهية أو ملغاة |
| 403 | `FORBIDDEN` | معروف، لكن دوره لا يملك الصلاحية (`message`: `Missing permission: <الصلاحية>`) |
| 404 | `NOT_FOUND` | غير موجود، **أو** موجود لكن ليس لك (لا نكشف وجوده) |
| 405 | `METHOD_NOT_ALLOWED` | المسار موجود بطريقة أخرى، ومعه ترويسة `Allow` |
| 409 | `CONFLICT`، `DUPLICATE_VALUE`، `INSUFFICIENT_STOCK`، `CART_CHECKED_OUT`، `PRODUCT_UNAVAILABLE`، `INVALID_STATUS_TRANSITION`، `INVALID_PAYMENT_TRANSITION`، `ORDER_NOT_REFUNDABLE`، `REFUND_EXCEEDS_PAID`، `IDEMPOTENCY_IN_PROGRESS`، `IDEMPOTENCY_KEY_REUSED` | تعارض مع الحالة الحالية |
| 412 | `PRECONDITION_FAILED` | `If-Match` لا يطابق النسخة الحالية (`details.currentVersion`)، أو بصيغة معطوبة |
| 413 | `PAYLOAD_TOO_LARGE` | الجسم أكبر من الحد (`details.limitBytes`) |
| 429 | `RATE_LIMITED` | محاولات كثيرة. `Retry-After` و`details.retryAfterSeconds` |
| 500 | `INTERNAL_ERROR` | خطأ داخلي. التفاصيل في سجل الخادم فقط (ابحث بـ `requestId`) |
| 502 | `BAD_GATEWAY`، `PAYMENT_PROVIDER_ERROR` | خدمة خارجية فشلت، مثل بوابة دفع رفضت الاسترجاع |
| 503 | `SERVICE_UNAVAILABLE`، `TRANSACTION_CONFLICT`، `QUERY_TIMEOUT` | مؤقت: القاعدة مشغولة أو لا ترد، أو إيقاف جارٍ. أعد المحاولة بعد `Retry-After` |

## المصادقة والصلاحيات

| المتصل | كيف يعرّف نفسه | الدور |
|---|---|---|
| صاحب المتجر | `X-Api-Key: <OWNER_API_KEY>` (والمفاتيح القديمة في `OWNER_API_KEY_PREVIOUS` أثناء تغيير المفتاح) | `owner` (كل الصلاحيات) |
| موظف | `Authorization: Bearer <token>` من `POST /staff/login` | دوره في جدول `staff`: `admin` أو `manager` أو `support` أو `courier` |
| زبون مسجَّل | `Authorization: Bearer <token>` من `POST /customers/register` أو `/customers/login` | `customer` |
| ضيف | بلا ترويسة | — |

**الجلسات:** كل توكن (زبون أو موظف) مربوط بجلسة في الخادم (جدول `auth_sessions`)، صالحة 7 أيام افتراضياً. التوكن الموقّع وحده لا يكفي: مع كل طلب يتأكد الخادم أن جلسته موجودة ولم تُلغَ ولم تنتهِ. لهذا يمكن إلغاء توكن فوراً قبل انتهاء مدته:

| ما يحدث | الجلسات التي تُلغى |
|---|---|
| `POST /customers/logout` أو `POST /staff/logout` | جلسة هذا الجهاز |
| `POST /customers/logout-all` | كل جلسات الزبون |
| تغيير كلمة المرور (`/customers/me/password` أو `/staff/me/password`) | كل الجلسات **ما عدا** هذا الجهاز |
| تعيين كلمة مرور بالاستعادة (`/customers/password-reset/confirm`) | كل جلسات الزبون |
| المالك يوقف موظفاً، أو يغيّر دوره، أو يضع له كلمة مرور (`PATCH /staff/:id`) | كل جلسات الموظف |

دور الموظف يُقرأ من القاعدة مع كل طلب، فتغيير الدور أو الإيقاف يسري فوراً. التوكن الذي أُلغيت جلسته أو انتهت يعطي **401** `INVALID_TOKEN` برسالة ثابتة `Invalid or expired token`: امسح التوكن المحفوظ، وأعد الطلب كضيف أو اطلب الدخول.

إرسال مفتاح أو توكن **خاطئ** يعطي 401 دائماً، ولا يُعامَل الطلب كضيف.

**الأدوار الافتراضية** (`DEFAULT_ROLES` في `src/engine/access-control.ts`؛ يستطيع المتجر تمرير جدول خاص به). `<المورد>:*` تعني كل العمليات على المورد:

| الدور | الصلاحيات |
|---|---|
| `owner` | `*`. وهو **وحده** يملك `staff:write` (إنشاء الموظفين وتعديلهم) |
| `admin` | `products:*`، `categories:*`، `inventory:*`، `orders:*` (ومنها `orders:refund` و`orders:assign`)، `deliveries:*`، `coupons:*`، `customers:read`، `staff:read`، `audit:read` |
| `manager` | `products:*`، `categories:*`، `inventory:*`، `orders:read-all`، `orders:write`، `orders:assign`، `deliveries:read-all`، `coupons:read`، `customers:read`، `staff:read` |
| `support` | `products:read`، `categories:read`، `orders:read-all`، `orders:write`، `deliveries:read-all`، `customers:read` |
| `courier` | `deliveries:read-own`، `deliveries:update-own` |
| `customer` | `products:read`، `categories:read`، `cart:manage`، `orders:create`، `orders:read-own`، `profile:manage` |

القاعدة: 401 = "سجّل دخولك"، و403 = "دورك لا يسمح"، و404 = "غير موجود أو ليس لك" (سلة غيرك، أو طلب غيرك، أو توصيل مسند لمندوب آخر).

**حدود المحاولات** (محفوظة في PostgreSQL افتراضياً، فهي مشتركة بين كل نسخ الخادم ولا تُصفَّر بإعادة التشغيل):

| الحد | القيمة الافتراضية |
|---|---|
| دخول فاشل (زبون، وموظف بعدّاد منفصل) | 10 خلال 15 دقيقة لكل عنوان IP **أو** لكل بريد، ثم 429 حتى لو كانت كلمة المرور صحيحة. الدخول الناجح يصفّر عدّاد البريد |
| إنشاء حساب زبون | 5 في الساعة لكل IP. تُحسب كل محاولة تصل لتشفير كلمة المرور، بما فيها البريد المكرر (409)، ولا يُحسب الرفض بـ 400 |
| طلب استعادة كلمة المرور | 5 في الساعة لكل IP ولكل بريد |
| الشراء، وإنشاء السلال | مطفأة افتراضياً (`checkoutRateLimit` و`cartCreationRateLimit`). متجر ماء يفعّلها: 30 طلباً كل 10 دقائق، و200 سلة في الساعة لكل IP |

خلف خادم وسيط واحد موثوق (nginx) اضبط `TRUST_PROXY=true` ليُقرأ عنوان الزبون الحقيقي من آخر `X-Forwarded-For`.

## منع التكرار (Idempotency-Key)

في `POST /orders` و`POST /orders/:id/refunds`. الموقع يولّد مفتاحاً عشوائياً (`crypto.randomUUID()`) **مرة لكل محاولة شراء**، ويعيد إرساله مع كل إعادة للطلب نفسه:

| الحالة | الرد |
|---|---|
| أول طلب بالمفتاح | يُنفَّذ، ويُحفظ رده (الرمز والجسم) |
| إعادة بنفس المفتاح ونفس الجسم | الرد المحفوظ نفسه (نفس الطلب، لا طلب ثانٍ)، مع `Idempotency-Replayed: true` |
| إعادة والطلب الأول ما زال يعمل | 409 `IDEMPOTENCY_IN_PROGRESS`: أعد بعد قليل |
| نفس المفتاح بجسم مختلف | 409 `IDEMPOTENCY_KEY_REUSED` (خطأ في الموقع) |

- يُحفظ الرد الناجح وأخطاء 4xx (ما عدا 429)، فالإعادة ترى نفس النتيجة. أخطاء 5xx و429 لا تُحفظ، فتستطيع الإعادة أن تنجح.
- المفتاح مقصور على المرسل: مفتاح زبون لا يصطدم بمفتاح غيره. يُحفظ 24 ساعة.
- الترويسة اختيارية: بدونها يعمل الطلب كما كان، وإعادة شراء نفس السلة تعطي 409 `CART_CHECKED_OUT`.

## التعديل المتفائل (ETag و If-Match)

للمنتجات والأقسام رقم نسخة `version` يزيد مع كل تعديل، ويعود في الجسم وفي ترويسة `ETag` (مثل `"3"`).

1. اقرأ السجل (`GET /products/:id`) واحفظ `ETag`.
2. أرسل التعديل أو الحذف مع `If-Match: "3"`.
3. إن عدّل أحد غيرك السجل بعد قراءتك: **412** `PRECONDITION_FAILED` و`details.currentVersion`. أعد القراءة واعرض التعديل الجديد على المستخدم.

بدون `If-Match` (أو بقيمة `*`) يُنفَّذ التعديل دون فحص (آخر من يحفظ يكتب فوق من سبقه).

---

## النظام والمراقبة

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/health` | عام | `{ status: "ok", database: "ok" }`، ويفحص القاعدة فعلياً. القاعدة لا ترد: 503 |
| GET | `/livez` | عام | `{ status: "ok" }`: العملية حية (لا يلمس القاعدة) |
| GET | `/readyz` | عام | `{ status: "ready" }`، أو 503 بـ `status`: `shutting_down` (إيقاف جارٍ)، أو `migrations_pending` مع `pending`، أو `database_unreachable` |
| GET | `/metrics` | عام، أو `Authorization: Bearer <METRICS_TOKEN>` إن ضُبط | مقاييس Prometheus (نص لا JSON): الطلبات ومددها لكل مسار، واتصالات القاعدة، والذاكرة، وتأخر حلقة الأحداث، وأحداث صندوق الصادر والمهام في الخلفية |
| GET | `/openapi.json` | عام | وصف OpenAPI 3.1 (نفس `docs/openapi.json`) |
| GET | `/audit-log` | `audit:read` (المالك والمدير) | سجل التدقيق، مرقّم. `?actorId=` و`?action=` (بداية العملية، مثل `PATCH /products`) |

**سجل التدقيق** يُكتب تلقائياً لكل طلب كتابة (`POST` و`PUT` و`PATCH` و`DELETE`) من المالك أو موظف، ناجحاً أو مرفوضاً، ولكل محاولة دخول موظف (`staff.login` و`staff.login_failed`). طلبات الزبائن لا تُسجَّل. كلمات المرور والتوكنات في الجسم تُحجب قبل الحفظ.

```json
{ "id": 42, "at": "…", "actorType": "staff", "actorId": "…", "actorRole": "manager",
  "action": "PATCH /products/:id", "route": "/products/:id", "path": "/products/…", "params": { "id": "…" },
  "statusCode": 200, "requestId": "…", "ip": "…", "body": { "price": 18000 } }
```

## التصنيفات

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/categories` | عام | مرقّمة، ومرتبة بالاسم |
| GET | `/categories/:id` | عام | ومعه `ETag` |
| POST | `/categories` | `categories:write` | body: `name` (1–120)، `slug`، `description?` → 201 |
| PATCH | `/categories/:id` | `categories:write` | أي حقول من السابقة (`description: null` يمسحه). `If-Match` اختياري |
| DELETE | `/categories/:id` | `categories:write` | 204. `If-Match` اختياري. المنتجات تبقى ويصبح `categoryId` = null |

`slug`: حروف إنجليزية صغيرة وأرقام وشرطات (`coffee-tea`)، وفريد (التكرار يعطي 409 `DUPLICATE_VALUE`).

```json
{ "id": "…", "name": "سماعات", "slug": "audio", "description": null, "version": 1, "createdAt": "…", "updatedAt": "…" }
```

## المنتجات والأشكال (Variants)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/products` | عام | مرقّمة. المفعّلة فقط، ومن يملك `products:write` يرى المخفية أيضاً. `?categoryId=` و`?q=` (بحث في الاسم) و`?sort=newest\|price_asc\|price_desc\|name` (الافتراضي `newest`) |
| GET | `/products/by-slug/:slug` | عام | نفس `GET /products/:id` بالرابط المقروء |
| GET | `/products/:id` | عام | المنتج مع `variants`، ومعه `ETag`. المخفي يعطي 404 للزائر |
| POST | `/products` | `products:write` | body: `name`، `slug`، `price`، `description?`، `categoryId?`، `isActive?`، `imageUrl?` → 201 |
| PATCH | `/products/:id` | `products:write` | الحقول المرسلة فقط. `description` و`categoryId` و`imageUrl` تقبل `null`. `If-Match` اختياري |
| DELETE | `/products/:id` | `products:write` | 204. `If-Match` اختياري. مخزونه وأشكاله تُحذف معه، والطلبات القديمة تحتفظ باسمه وسعره |
| GET | `/products/:id/variants` | عام | الأشكال (النشطة فقط للعامة)، بترتيب `position` |
| POST | `/products/:id/variants` | `products:write` | body: `sku`، `title`، `price?` (null = سعر المنتج)، `isActive?`، `position?` → 201 |
| PATCH | `/products/:id/variants/:variantId` | `products:write` | الحقول المرسلة فقط (`price: null` يعيده لسعر المنتج) |
| DELETE | `/products/:id/variants/:variantId` | `products:write` | 204 |

```json
{ "id": "…", "name": "ساعة ذكية رياضية", "slug": "sport-smartwatch", "description": "…", "price": 250000,
  "categoryId": "…", "isActive": true, "imageUrl": "/images/products/sport-smartwatch.webp", "version": 2,
  "createdAt": "…", "updatedAt": "…",
  "variants": [ { "id": "…", "productId": "…", "sku": "WATCH-SPT-46", "title": "مقاس 46 ملم", "price": 270000,
                  "isActive": true, "position": 1, "createdAt": "…", "updatedAt": "…" } ] }
```

- `imageUrl`: **رابط** للصورة لا ملف، فالصور نفسها تُخزَّن مع الواجهة أو في CDN. يقبل رابطاً كاملاً `https://…` أو مساراً في موقع المتجر `/images/…`، ويرفض غير ذلك (مثل `javascript:`) لمنع حقن كود في الواجهة.
- `categoryId` لقسم غير موجود: 400 `REFERENCE_NOT_FOUND`. `slug` أو `sku` مكرر: 409 `DUPLICATE_VALUE`.
- **الشكل:** نسخة من المنتج تختلف في خاصية (لون، مقاس) برمز SKU فريد (`A-Z a-z 0-9 . _ -`، حتى 64)، وسعر خاص اختياري، ومخزون خاص. **المنتج الذي له أشكال نشطة لا يُضاف للسلة إلا بشكل محدد** (`VARIANT_REQUIRED`). المنتج بلا أشكال يعمل كما كان.

## المخزون

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/inventory/:productId` | عام | `{ productId, quantity, inStock, variants? }`، و`variants` مخزون كل شكل `{ variantId, productId, sku, quantity, inStock }` |
| PUT | `/inventory/:productId` | `inventory:write` | body: `{ quantity }` (تعيين، 0–1,000,000) |
| POST | `/inventory/:productId/adjust` | `inventory:write` | body: `{ delta }` (+ زيادة / − نقص)، و409 `INSUFFICIENT_STOCK` إن صار سالباً |
| PUT | `/inventory/variants/:variantId` | `inventory:write` | body: `{ quantity }`: مخزون شكل |
| POST | `/inventory/variants/:variantId/adjust` | `inventory:write` | body: `{ delta }` |

الكتابة ترد بمستوى المخزون الجديد، وتطلق الحدث `inventory.changed`.

## الزبائن والجلسات (الحساب اختياري)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/customers/register` | عام | body: `email`، `password` (8–128)، `name`، `phone?`، `guestCartId?` → 201 `{ customer, token, cartId? }` |
| POST | `/customers/login` | عام | body: `email`، `password`، `guestCartId?` → `{ customer, token, cartId? }` |
| POST | `/customers/logout` | زبون | 204: يُلغي جلسة هذا الجهاز |
| POST | `/customers/logout-all` | زبون | 204: يُلغي كل جلسات الحساب |
| GET | `/customers/me` | زبون | بياناته |
| PATCH | `/customers/me` | `profile:manage` | body: `name?`، `phone?` (`null` يمسح الهاتف) |
| GET | `/customers/me/sessions` | زبون | الأجهزة الداخلة الآن: `[{ id, createdAt, expiresAt, ip, userAgent, current }]` |
| POST | `/customers/me/password` | زبون | body: `currentPassword`، `newPassword` (8–128) → 204. الحالية خاطئة: 400 `INVALID_CREDENTIALS` |
| POST | `/customers/password-reset` | عام | body: `{ email }` → **202 دائماً** `{ status: "accepted" }` |
| POST | `/customers/password-reset/confirm` | عام | body: `token`، `password` (8–128) → `{ status: "ok" }`. رمز خاطئ أو منتهٍ أو مستخدم: 400 `INVALID_RESET_TOKEN` |
| GET | `/customers` | `customers:read` | مرقّمة. `?q=` بحث في البريد والاسم والهاتف |
| GET | `/customers/:id` | `customers:read` | |

```json
{ "customer": { "id": "…", "email": "fatima@example.ly", "name": "فاطمة", "phone": "0913334455", "createdAt": "…", "updatedAt": "…" },
  "token": "…", "cartId": "…" }
```

- **"زبون"** في عمود الصلاحية تعني توكن زبون. المالك أو موظف على مسارات `/customers/me…` يحصل على 403 (ليس له ملف زبون).
- كلمة المرور الخاطئة والبريد غير المسجَّل يعطيان **نفس** الرد 401 `INVALID_CREDENTIALS` وبنفس الزمن تقريباً، حتى لا يُعرف أي البريدات مسجَّلة. كلمة المرور لا تُرجع أبداً، ولا حتى مشفّرة. البريد المكرر عند التسجيل: 409 `DUPLICATE_VALUE` (المقارنة دون حساسية لحالة الأحرف).
- **دمج سلة الضيف (`guestCartId`):** إن أرسل الموقع رقم سلة الضيف مع التسجيل أو الدخول، تُدمج سطورها في السلة المفتوحة للزبون (أو تُنقل إليه إن لم تكن له سلة). `cartId` في الرد هو السلة الناتجة، فاحفظه بدل القديم. يكون `null` إن تعذّر الدمج (سلة اشتُريت، أو لزبون آخر)، ولا يظهر إن لم يُرسل `guestCartId`.
- **استعادة كلمة المرور:** الرد 202 نفسه لأي بريد، مسجَّلاً كان أو لا. الرمز صالح 30 دقيقة ولمرة واحدة، ويُحفظ في القاعدة كبصمة لا كنص. **الإطار لا يرسل بريداً بنفسه:** يطلق الحدث `customer.passwordResetRequested` (فيه الرمز)، وإضافة بريد أو رسائل ترسله للزبون (في متجر ماء: إضافة `dev-mailbox` للتطوير).

## الموظفون

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/staff/login` | عام | body: `email`، `password` → `{ staff, token }` |
| POST | `/staff/logout` | موظف | 204: يُلغي جلسة هذا الجهاز |
| GET | `/staff/me` | موظف | حسابه |
| POST | `/staff/me/password` | موظف | body: `currentPassword`، `newPassword` → 204 (يُخرج أجهزته الأخرى) |
| GET | `/staff/roles` | `staff:read` | الأدوار المتاحة لحسابات الموظفين: `["admin","manager","support","courier"]` |
| GET | `/staff` | `staff:read` | مرقّمة. `?role=` (مثل `courier`) و`?q=` (البريد أو الاسم) |
| POST | `/staff` | `staff:write` (**المالك فقط**) | body: `email`، `password` (8–128)، `name`، `phone?`، `role` → 201 |
| GET | `/staff/:id` | `staff:read` | |
| PATCH | `/staff/:id` | `staff:write` (**المالك فقط**) | body: `name?`، `phone?` (null يمسحه)، `role?`، `isActive?`، `password?`. الإيقاف أو تغيير الدور أو كلمة المرور يُلغي كل جلساته |

```json
{ "staff": { "id": "…", "email": "courier1@maa.ly", "name": "سالم المندوب", "phone": "0920000001",
             "role": "courier", "isActive": true, "createdAt": "…", "updatedAt": "…" }, "token": "…" }
```

- `role` يجب أن يكون دور موظف معرّفاً في جدول الصلاحيات (ليس `owner` ولا `customer`)، وإلا 400 مع القائمة المسموحة. البريد المكرر: 409 `DUPLICATE_VALUE`.
- الحساب الموقوف يعطي عند الدخول نفس 401 `INVALID_CREDENTIALS` التي تعطيها كلمة المرور الخاطئة. حد محاولات الدخول نفسه المطبّق على الزبائن (بعدّاد منفصل).
- "موظف" في عمود الصلاحية تعني توكن موظف؛ المالك بمفتاحه ليس له حساب موظف (403).
- **المدير (`admin`) لا يستطيع إنشاء موظفين**، حتى لا يصنع حساباً بصلاحيات أعلى منه.

## السلة (ضيف أو زبون)

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/carts` | 201: سلة جديدة. إن أُرسل توكن زبون تُربط بحسابه |
| GET | `/carts/mine` | توكن زبون: أحدث سلة مفتوحة له، أو **204 بلا جسم** إن لم توجد |
| GET | `/carts/:id` | السلة مع سطورها ومجموعها |
| POST | `/carts/:id/items` | body: `{ productId, variantId?, quantity }` (1–1000، يُضاف للكمية الموجودة) |
| PUT | `/carts/:id/items/:productId?variantId=` | body: `{ quantity }` (تعيين 0–1000، و0 يحذف السطر). `?variantId=` لسطر شكل |
| DELETE | `/carts/:id/items/:productId?variantId=` | حذف السطر (الرد: السلة) |

كل تعديل يرد بالسلة كاملة:

```json
{ "id": "…", "customerId": null, "status": "open", "total": 295000,
  "items": [
    { "productId": "…", "variantId": null, "sku": null, "name": "شاحن سريع 20 واط USB-C", "variantTitle": null,
      "imageUrl": "/images/products/fast-charger-20w.webp", "unitPrice": 35000, "quantity": 1, "lineTotal": 35000, "available": true },
    { "productId": "…", "variantId": "…", "sku": "WATCH-SPT-42", "name": "ساعة ذكية رياضية", "variantTitle": "مقاس 42 ملم",
      "imageUrl": "/images/products/sport-smartwatch.webp", "unitPrice": 250000, "quantity": 1, "lineTotal": 250000, "available": true } ],
  "createdAt": "…", "updatedAt": "…" }
```

- **السطر** يحدده المنتج والشكل معاً: نفس المنتج بلونين = سطران. `unitPrice` هو السعر الحالي (سعر الشكل إن وُجد، وإلا سعر المنتج).
- **`available: false`**: المنتج أو الشكل أُخفي بعد إضافته. لا يُحسب في `total`، ويمنع الشراء حتى يُحذف.
- **سلة الضيف:** معرّفها سرّ، فاحفظه في المتصفح (localStorage). من يملك المعرّف يستطيع استخدامها. سلال الضيوف التي لم تتغير 30 يوماً تُحذف تلقائياً.
- **سلة الزبون:** لصاحبها فقط (أو المالك). غيرهما يحصل على 404. الموظف الذي لا يملك `cart:manage` يحصل على 403.
- **الأخطاء عند الإضافة:** منتج أو شكل غير موجود أو مخفي: 404. منتج له أشكال دون `variantId`: 400 `VARIANT_REQUIRED`. المخزون لا يكفي للكمية الجديدة كلها: 409 `INSUFFICIENT_STOCK` و`details: { productId, variantId, available, requested }`. سلة اشتُريت: 409 `CART_CHECKED_OUT`.
- **المخزون** يُفحص عند الإضافة، ويُحجز فعلياً عند إتمام الطلب فقط.

## إتمام الشراء والطلبات

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/checkout/options` | عام | العملة، وهل المتجر يقبل كوبونات، وطرق الشحن والدفع من الإضافات |
| POST | `/checkout/quote` | صاحب السلة | body: `{ cartId, shippingAddress, shippingCity?, shippingMethod?, couponCode? }` → التسعير، دون أي أثر جانبي |
| POST | `/orders` | ضيف أو `orders:create` | body: `{ cartId, contactName, contactPhone, shippingAddress, shippingCity?, shippingMethod?, paymentMethod?, couponCode? }` → 201. `Idempotency-Key` اختياري |
| GET | `/orders` | مسجَّل | مرقّمة. من يملك `orders:read-all` يرى الكل، والزبون يرى طلباته (المندوب: 403). `?status=` و`?paymentStatus=` و`?q=` (للموظفين: جزء من اسم المستلم، أو بداية رقم الطلب، أو أرقام من الهاتف) |
| GET | `/orders/:id` | — | `orders:read-all`، أو الزبون صاحب الطلب، أو ضيف يرسل `?phone=` مطابقاً لهاتف الطلب (تُقارن الأرقام فقط) |
| GET | `/orders/:id/events` | مثل السابق | سجل الطلب الزمني (لصفحة التتبع) |
| PATCH | `/orders/:id/status` | `orders:write` | body: `{ status, note? }` |
| PATCH | `/orders/:id/payment` | `orders:write` | body: `{ status: "pending" \| "paid" \| "failed", reference? }` |
| POST | `/orders/:id/refunds` | `orders:refund` (المالك والمدير) | body: `{ amount, reason?, restock? }` → 201 `{ order, refund }`. `Idempotency-Key` اختياري |
| GET | `/orders/:id/refunds` | `orders:read-all` | الاسترجاعات |

**خيارات الشراء:**

```json
{ "currency": "LYD", "couponsEnabled": true,
  "shippingMethods": [ { "id": "city-rate", "name": "توصيل للمنزل", "cities": ["تاجوراء", "طرابلس", "بنغازي"] },
                       { "id": "pickup", "name": "استلام من المحل - تاجوراء" } ],
  "paymentMethods": [ { "id": "cod", "name": "الدفع نقداً عند الاستلام" }, { "id": "card", "name": "بطاقة مصرفية (تجريبي)" } ] }
```

- `shippingMethod` و`paymentMethod` مطلوبان فقط إن كانت في المتجر إضافات شحن/دفع، ويجب أن يكونا من المعروض (وإلا 400 بقائمة المتاح). متجر بلا إضافات: الشحن مجاني ولا خطوة دفع (`paymentStatus: "unpaid"`).
- **التوصيل حسب المدينة** (إضافة `cityRateShipping`): الطريقة تظهر ومعها `cities`. تبني الواجهة منها القائمة المنسدلة، وترسل المدينة المختارة في `shippingCity`. المدينة غير المخدومة أو الناقصة تعطي 400، ويسرد `details` المدن المتاحة. الطلب يحفظ المدينة في `shippingCity`.
- **الكوبون** (`couponCode`): يحتاج إضافة معدّل سعر مثبتة (`couponsEnabled: true`)، وإلا 400. الكوبون غير الصالح (غير موجود، منتهٍ، استُنفد، أو المجموع أقل من الحد الأدنى) يعطي 400 `INVALID_COUPON` برسالة للمشتري.

**التسعير** (`/checkout/quote`، ونفس الحقول في الطلب):

```json
{ "currency": "LYD", "subtotal": 72000, "shippingMethod": "city-rate", "shippingCost": 10000,
  "adjustments": [ { "code": "COUPON:WELCOME10", "label": "Coupon WELCOME10 (10%)", "type": "discount", "amount": 7200, "source": "coupons" } ],
  "adjustmentsTotal": -7200, "total": 74800 }
```

`adjustments` بنود من إضافات معدّلات السعر (الكوبونات، والضريبة `percentageTax`...): `amount` موجب دائماً، و`type` يحدد هل يُطرح (`discount`) أو يُضاف (`tax`، `fee`). `adjustmentsTotal` مجموعها بالإشارة، و**`total = subtotal + shippingCost + adjustmentsTotal`** (تفرضها القاعدة نفسها بقيد CHECK). المنتجات غير المتاحة لا تُحسب في التسعير.

**إتمام الشراء كتلة واحدة:** إما أن يتم كله أو لا يتم منه شيء. إن نفد أي منتج (409 `INSUFFICIENT_STOCK`) أو أصبح غير متاح (409 `PRODUCT_UNAVAILABLE` و`details.productIds`) لا يُباع شيء وتبقى السلة مفتوحة. سلة فارغة: 400 `CART_EMPTY`. السلة لا تتحول لطلب مرتين (409 `CART_CHECKED_OUT`، أو الطلب نفسه مع `Idempotency-Key`). الطلب يحفظ **اسم المنتج وسعره وشكله وقت الشراء**، فتعديل المنتج أو حذفه لاحقاً لا يغيّر الطلبات القديمة.

**الطلب:**

```json
{ "id": "…", "customerId": null, "status": "pending", "contactName": "…", "contactPhone": "…",
  "shippingAddress": "…", "shippingCity": "طرابلس", "currency": "LYD",
  "subtotal": 72000, "shippingMethod": "city-rate", "shippingCost": 10000,
  "adjustments": [ { "code": "COUPON:WELCOME10", "label": "Coupon WELCOME10 (10%)", "type": "discount", "amount": 7200, "source": "coupons" } ],
  "adjustmentsTotal": -7200, "total": 74800,
  "paymentMethod": "card", "paymentStatus": "pending", "paymentReference": "DEMO-3f0c9a52",
  "paymentExpiresAt": "2026-11-02T10:30:00.000Z", "refundedTotal": 0,
  "items": [ { "productId": "…", "variantId": null, "sku": null, "productName": "…", "variantTitle": null,
               "unitPrice": 36000, "quantity": 2, "lineTotal": 72000, "restockedQuantity": 0 } ],
  "createdAt": "…", "updatedAt": "…",
  "payment": { "status": "pending", "redirectUrl": "http://localhost:5173/pay.html?order=…&phone=…",
               "instructions": "أكمل الدفع خلال 15 دقيقة، وإلا يُلغى الطلب تلقائياً.", "reference": "DEMO-3f0c9a52" } }
```

`payment` يظهر في رد الإنشاء فقط: ما ردت به إضافة الدفع، أي رسالة للمشتري (`instructions`) أو رابط صفحة دفع (`redirectUrl`) ينقل الموقع المشتري إليه، أو `null` إن لم تكن في المتجر إضافة دفع.

**حالات الطلب:** `pending` ← `confirmed` ← `shipped` ← `delivered`. الإلغاء `cancelled` مسموح قبل الشحن فقط، ويعيد إلى المخزون ما لم يُعد منه بعد. `delivered` و`cancelled` نهائيتان. انتقال غير مسموح: 409 `INVALID_STATUS_TRANSITION` و`details.allowed`.

**حالات الدفع (آلة حالات):**

| من | إلى |
|---|---|
| `unpaid` | `pending`، `paid`، `failed` |
| `pending` | `paid`، `failed` |
| `failed` | `pending`، `paid` |
| `paid` | `partially_refunded`، `refunded` (بالاسترجاع فقط) |
| `partially_refunded` | `partially_refunded`، `refunded` (بالاسترجاع فقط) |
| `refunded` | — |

- `PATCH /orders/:id/payment` يقبل `pending` و`paid` و`failed` فقط. حالتا الاسترجاع لا تُضبطان يدوياً، بل عبر `POST /orders/:id/refunds`.
- **نفس الحالة مرة ثانية ليست خطأ:** تُقبل دون أي تغيير (بوابة الدفع قد ترسل نفس الـ webhook مرتين). انتقال غير مسموح: 409 `INVALID_PAYMENT_TRANSITION` و`details.allowed`.
- بعد حفظ الطلب يبدأ الدفع عبر الإضافة. إن فشلت الإضافة، يبقى الطلب محفوظاً بحالة دفع `failed` ولا يُلغى.

**مهلة الدفع (حجز البضاعة):** إن كان لإضافة الدفع `holdSeconds` (مثل البطاقة التجريبية في متجر ماء: 15 دقيقة)، يحمل الطلب غير المدفوع `paymentExpiresAt`. إن بقي `pending` ولم يُدفع حتى ذلك الوقت، يُلغى تلقائياً (مهمة كل دقيقة)، ويعود مخزونه، ويُسجَّل في سجله الزمني بالملاحظة `payment_expired`. الدفع يمسح المهلة. `null` يعني لا مهلة (مثل الدفع عند الاستلام).

**السجل الزمني** (`GET /orders/:id/events`): كل ما حدث للطلب بالترتيب، ومن فعله:

```json
[ { "id": 1, "at": "…", "type": "created", "from": null, "to": "pending", "actorType": "guest", "note": null },
  { "id": 2, "at": "…", "type": "status", "from": "pending", "to": "confirmed", "actorType": "staff", "note": "Confirmed on assignment" },
  { "id": 3, "at": "…", "type": "delivery", "from": null, "to": "assigned", "actorType": "staff", "note": null } ]
```

`type`: `created` أو `status` أو `payment` أو `refund` أو `delivery`. `actorType`: `owner` أو `staff` أو `customer` أو `guest` أو `system`. رقم الموظف لا يُرسل (يُحفظ للتدقيق فقط).

**الاسترجاع** (`POST /orders/:id/refunds`):

- للطلب المدفوع فقط (`paid` أو `partially_refunded`)، وإلا 409 `ORDER_NOT_REFUNDABLE`. المبلغ أكبر من المتبقي (`total - refundedTotal`): 409 `REFUND_EXCEEDS_PAID` و`details.refundable`.
- `restock` اختياري: `[{ productId, variantId?, quantity }]` كميات تعود للمخزون. كل سطر يجب أن يكون في الطلب، ولا يتجاوز ما لم يُعد بعد، وإلا 400 بحقل مثل `restock[0].quantity`.
- إن كان لإضافة الدفع `refund`، تُستدعى البوابة. إن رفضت: 502 `PAYMENT_PROVIDER_ERROR` ولا يتغير شيء.
- النتيجة: حالة الدفع `partially_refunded` أو `refunded`، و`refundedTotal` يزيد، وسطر في السجل الزمني.

```json
{ "order": { "…": "…", "paymentStatus": "partially_refunded", "refundedTotal": 20000 },
  "refund": { "id": "…", "orderId": "…", "amount": 20000, "reason": "قطعة تالفة", "status": "succeeded",
              "reference": "DEMO-RF-…", "restock": [ { "productId": "…", "variantId": null, "quantity": 1 } ],
              "createdAt": "…", "completedAt": "…" } }
```

## التوصيل (جانب المندوب)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/orders/:id/delivery` | `orders:assign` (المالك والمدير والمشرف) | body: `{ courierId, note? }` → 201: إسناد الطلب لمندوب، أو إعادة إسناده بعد محاولة فاشلة |
| GET | `/orders/:id/delivery` | — | من يملك `deliveries:read-all` أو `orders:read-all`، والمندوب المسند، والزبون صاحب الطلب، والضيف بـ `?phone=` |
| GET | `/deliveries` | `deliveries:read-all` أو `deliveries:read-own` | مرقّمة. المندوب يرى توصيلاته فقط، والمدير والمشرف والدعم يرون الكل. `?status=` و`?courierId=` (للكل فقط) |
| POST | `/deliveries/:orderId/pickup` | المندوب المسند، أو `deliveries:update-all` | body: `{ note? }`: استلم الطلب من المحل، فيصبح الطلب `shipped` |
| POST | `/deliveries/:orderId/deliver` | مثل السابق | body: `{ cashCollected?, note? }`: سلّمه، فيصبح الطلب `delivered` |
| POST | `/deliveries/:orderId/fail` | مثل السابق | body: `{ note }` (إلزامي): محاولة لم تنجح، والطلب يبقى كما هو |

```json
{ "orderId": "…", "courierId": "…", "courierName": "سالم المندوب", "courierPhone": "0920000001",
  "status": "picked_up", "cashCollected": null, "note": null, "attempts": 1,
  "assignedAt": "…", "pickedUpAt": "…", "deliveredAt": null, "updatedAt": "…" }
```

في `GET /deliveries` كل عنصر يحمل أيضاً `order`: ملخص ما يحتاجه المندوب `{ id, status, contactName, contactPhone, shippingAddress, shippingCity, total, currency, paymentMethod, paymentStatus, itemCount, createdAt }`.

- **حالات التوصيل:** `assigned` ← `picked_up` ← `delivered`، و`failed` من `assigned` أو `picked_up`. بعد `failed` يمكن الاستلام مرة أخرى أو إعادة الإسناد. انتقال غير مسموح: 409 `INVALID_STATUS_TRANSITION`.
- **الإسناد:** الطلب يجب أن يكون `pending` أو `confirmed` أو `shipped` (والطلب `pending` يُؤكَّد تلقائياً). `courierId` يجب أن يكون حساب موظف نشطاً بدور يملك `deliveries:update-own`، وإلا 400. توصيل استُلم أو سُلّم لا يُعاد إسناده (409).
- **التسليم والتحصيل:** الطلب غير المدفوع (الدفع عند الاستلام) يحتاج `cashCollected` **يساوي إجمالي الطلب بالضبط**، فيصبح الطلب مدفوعاً `paid`. الطلب المدفوع مسبقاً لا يقبل تحصيلاً (`cashCollected` يجب أن يكون 0 أو غائباً). المخالفة: 400.
- مندوب يحاول تحريك توصيل غيره: 404. دور بلا `deliveries:update-own`/`update-all`: 403.
- كل خطوة تُكتب في السجل الزمني (النوع `delivery`) وتطلق الحدث `order.deliveryChanged`.

## الكوبونات (إضافة `coupons`)

موجودة فقط إن ثُبّتت الإضافة `coupons()` (متجر ماء يثبّتها).

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/coupons` | `coupons:read` | مرقّمة، الأحدث أولاً |
| POST | `/coupons` | `coupons:write` | body: `code`، `kind` (`percent` \| `fixed`)، `value`، `minSubtotal?`، `maxRedemptions?`، `expiresAt?`، `isActive?` → 201 |
| PATCH | `/coupons/:code` | `coupons:write` | `value?`، `minSubtotal?`، `maxRedemptions?` (null بلا حد)، `expiresAt?` (null بلا انتهاء)، `isActive?` |
| DELETE | `/coupons/:code` | `coupons:write` | 204 |

```json
{ "code": "SAVE20", "kind": "fixed", "value": 20000, "minSubtotal": 200000, "maxRedemptions": null,
  "redeemedCount": 3, "expiresAt": null, "isActive": true, "createdAt": "…", "updatedAt": "…" }
```

- `code`: 3–40 من الحروف الإنجليزية الكبيرة والأرقام و`-` و`_`، ويُحوَّل لحروف كبيرة. المكرر: 400 `DUPLICATE_VALUE` بحقل `code`.
- `percent`: `value` من 1 إلى 100 (الخصم يُقرَّب للأسفل). `fixed`: مبلغ بأصغر وحدة، ولا يتجاوز المجموع. `expiresAt` تاريخ ISO.
- الاستخدام يُعدّ بعد الشراء (`redeemedCount`)، ويعود عند إلغاء الطلب.

## مسارات خاصة بمتجر ماء (ليست من الإطار)

إضافات المتجر في `storefront/api/plugins` تضيف: `POST /payments/card/webhook` (webhook موقّع للبوابة التجريبية)، و`POST /payments/card/simulate` (صفحة الدفع التجريبية)، و`GET /dev/mailbox?to=` (صندوق بريد التطوير، فقط مع `DEMO_MODE=true`). التفاصيل في `storefront/README.md`.
