# عقد الـ API (API Contract)

هذا المرجع موجَّه لمن يبني واجهة المتجر (موقع أو تطبيق جوال) فوق الإطار. كل المسارات تُرجع JSON.

## قواعد عامة

| البند | القاعدة |
|---|---|
| صيغة الطلب | `Content-Type: application/json` لأي طلب له body |
| المبالغ | أعداد صحيحة **بأصغر وحدة للعملة**: للدينار الليبي الدرهم (`1 LYD = 1000`). مثال: `15000` = 15 د.ل |
| المعرّفات | UUID. معرّف بصيغة خاطئة يُعامَل كغير موجود (404) |
| الترقيم | `?limit=` (1–100، الافتراضي 50) و`?offset=` في كل القوائم |
| الحقول | أسماء camelCase. أي حقل غير معرّف في الطلب يُرفض بـ 400 |
| CORS | مفعّل، والمصدر المسموح يُضبط بـ `CORS_ORIGIN` |

### شكل الخطأ (موحّد في كل المسارات)

```json
{ "error": { "message": "Validation failed", "details": [ { "field": "price", "message": "must be >= 0" } ] } }
```

| الرمز | المعنى |
|---|---|
| 400 | مدخلات غير صالحة (`details` يسرد كل الحقول المخالفة دفعة واحدة) أو JSON تالف |
| 401 | لا توجد بيانات دخول، أو بيانات دخول خاطئة أو منتهية |
| 403 | مسجَّل لكن دوره لا يملك الصلاحية |
| 404 | غير موجود، **أو** موجود لكن ليس لك (لا نكشف وجوده) |
| 409 | تعارض: قيمة فريدة مكررة، مخزون غير كافٍ، سلة أُغلقت، انتقال حالة غير مسموح |
| 429 | محاولات كثيرة (دخول فاشل أو إنشاء حسابات). الترويسة `Retry-After` تحدد بعد كم ثانية يمكن المحاولة |
| 500 | خطأ داخلي (التفاصيل في سجل الخادم فقط، لا تُرسل للعميل) |

## المصادقة والصلاحيات

| المتصل | كيف يعرّف نفسه | الدور |
|---|---|---|
| صاحب المتجر | الترويسة `X-Api-Key: <OWNER_API_KEY>` | `owner` (كل الصلاحيات) |
| زبون مسجَّل | الترويسة `Authorization: Bearer <token>` (من التسجيل أو الدخول، صالح 7 أيام) | `customer` |
| ضيف | بلا ترويسة | — |

صلاحيات الزبون: `products:read`، `categories:read`، `cart:manage`، `orders:create`، `orders:read-own`، `profile:manage`.

إرسال مفتاح أو توكن **خاطئ** يعطي 401 دائماً، ولا يُعامَل الطلب كضيف.

---

## التصنيفات

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/categories` | عام | قائمة مرتبة بالاسم |
| GET | `/categories/:id` | عام | |
| POST | `/categories` | `categories:write` | body: `name`، `slug`، `description?` |
| PATCH | `/categories/:id` | `categories:write` | أي حقول من السابقة |
| DELETE | `/categories/:id` | `categories:write` | 204. المنتجات تبقى ويصبح `categoryId` = null |

`slug`: حروف إنجليزية صغيرة وأرقام وشرطات (`coffee-tea`)، وفريد (التكرار يعطي 409).

## المنتجات

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/products?categoryId=` | عام | المفعّلة فقط، والمالك يرى المخفية أيضاً |
| GET | `/products/:id` | عام | المخفي يعطي 404 للزائر |
| POST | `/products` | `products:write` | body: `name`، `slug`، `price`، `description?`، `categoryId?`، `isActive?` |
| PATCH | `/products/:id` | `products:write` | يعدّل الحقول المرسلة فقط |
| DELETE | `/products/:id` | `products:write` | 204. مخزونه يُحذف معه، والطلبات القديمة تحتفظ باسمه وسعره |

```json
{ "id": "…", "name": "Blue Mug", "slug": "blue-mug", "description": null, "price": 15000,
  "categoryId": "…", "isActive": true, "createdAt": "…", "updatedAt": "…" }
```

## المخزون

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/inventory/:productId` | عام | `{ productId, quantity, inStock }` |
| PUT | `/inventory/:productId` | `inventory:write` | body: `{ quantity }` (تعيين) |
| POST | `/inventory/:productId/adjust` | `inventory:write` | body: `{ delta }` (+ زيادة / − نقص)، 409 إن صار سالباً |

## الزبائن (الحساب اختياري)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/customers/register` | عام | body: `email`، `password` (8+)، `name`، `phone?` → 201 `{ customer, token }` |
| POST | `/customers/login` | عام | body: `email`، `password` → `{ customer, token }` |
| GET | `/customers/me` | زبون | بياناته |
| PATCH | `/customers/me` | `profile:manage` | body: `name?`، `phone?` |
| GET | `/customers` | `customers:read` (المالك) | القائمة |
| GET | `/customers/:id` | `customers:read` (المالك) | |

كلمة المرور الخاطئة والبريد غير المسجَّل يعطيان **نفس** الرد 401، حتى لا يُعرف أي البريدات مسجَّلة. كلمة المرور لا تُرجع أبداً، ولا حتى مشفّرة.

**تحديد محاولات الدخول:** بعد 10 محاولات فاشلة خلال 15 دقيقة من نفس عنوان IP، **أو** على نفس البريد، يُرد بـ **429** حتى انتهاء المدة، حتى لو كانت كلمة المرور صحيحة. الدخول الناجح يصفّر عدّاد البريد. خلف خادم وسيط (nginx) اضبط `TRUST_PROXY=true` ليُقرأ عنوان الزبون الحقيقي.

**تحديد إنشاء الحسابات:** 5 محاولات إنشاء حساب في الساعة لكل عنوان IP، ثم 429. تُحسب كل محاولة تصل لتشفير كلمة المرور، بما فيها البريد المكرر (409). الطلب المرفوض بـ 400 (مدخلات غير صالحة) لا يُحسب.

## السلة (ضيف أو زبون)

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/carts` | إنشاء سلة. إن أُرسل توكن زبون تُربط بحسابه |
| GET | `/carts/:id` | السلة مع بنودها ومجموعها |
| POST | `/carts/:id/items` | body: `{ productId, quantity }` (يُضاف للكمية الموجودة) |
| PUT | `/carts/:id/items/:productId` | body: `{ quantity }` (تعيين، و0 يحذف البند) |
| DELETE | `/carts/:id/items/:productId` | حذف البند |

- **سلة الضيف:** معرّفها سرّ، فاحفظه في المتصفح (localStorage). من يملك المعرّف يستطيع استخدامها.
- **سلة الزبون:** لصاحبها فقط (أو المالك). غيرهما يحصل على 404.
- **المخزون:** يُفحص عند الإضافة (409 إن لم يكفِ)، ويُحجز فعلياً عند إتمام الطلب فقط.

```json
{ "id": "…", "customerId": null, "status": "open", "total": 38000,
  "items": [ { "productId": "…", "name": "Mug", "unitPrice": 15000, "quantity": 2, "lineTotal": 30000, "available": true } ] }
```

## إتمام الشراء والطلبات

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/checkout/options` | عام | طرق الشحن والدفع التي توفرها الإضافات المثبتة |
| POST | `/checkout/quote` | صاحب السلة | body: `{ cartId, shippingAddress, shippingMethod? }` → `{ subtotal, shippingMethod, shippingCost, total }` |
| POST | `/orders` | ضيف أو زبون | body: `{ cartId, contactName, contactPhone, shippingAddress, shippingMethod?, paymentMethod? }` → 201 |
| GET | `/orders?status=` | مسجَّل | المالك يرى الكل، والزبون يرى طلباته |
| GET | `/orders/:id` | — | المالك، أو صاحب الطلب، أو ضيف يرسل `?phone=` مطابقاً لهاتف الطلب |
| PATCH | `/orders/:id/status` | `orders:write` | body: `{ status }` |
| PATCH | `/orders/:id/payment` | `orders:write` | body: `{ status, reference? }` |

**إتمام الشراء كتلة واحدة:** إما أن يتم كله أو لا يتم منه شيء. إن نفد أي منتج (409) لا يُباع شيء وتبقى السلة مفتوحة. السلة لا تتحول لطلب مرتين. `shippingMethod` و`paymentMethod` مطلوبان فقط إن كانت في المتجر إضافات شحن/دفع.

**حالات الطلب:** `pending` ← `confirmed` ← `shipped` ← `delivered`. ويمكن الإلغاء `cancelled` قبل الشحن فقط، والإلغاء يعيد الكميات إلى المخزون.

**حالات الدفع:** `unpaid` (لا إضافة دفع)، `pending`، `paid`، `failed`، `refunded`.

استجابة إنشاء الطلب تتضمن `payment`: رسالة للمشتري (`instructions`) أو رابط صفحة دفع (`redirectUrl`).

```json
{ "id": "…", "status": "pending", "subtotal": 72000, "shippingMethod": "flat-rate", "shippingCost": 10000,
  "total": 82000, "paymentMethod": "cod", "paymentStatus": "pending", "paymentReference": null,
  "contactName": "…", "contactPhone": "…", "shippingAddress": "…",
  "items": [ { "productId": "…", "productName": "…", "unitPrice": 18500, "quantity": 2, "lineTotal": 37000 } ],
  "payment": { "status": "pending", "instructions": "Pay the courier in cash when your order arrives." } }
```

الطلب يحفظ **اسم المنتج وسعره وقت الشراء**، فتعديل المنتج أو حذفه لاحقاً لا يغيّر الطلبات القديمة.

## أخرى

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/health` | `{ status, database }`، ويفحص الاتصال بقاعدة البيانات فعلياً |
