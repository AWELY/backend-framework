# تشغيل المشروع على جهاز جديد (لأعضاء الفريق)

> **تستخدم Linux؟** اتبع `docs/SETUP-LINUX.md` بدل هذا الملف.

الدليل لنظام Windows، ويستغرق نحو 15 دقيقة في المرة الأولى. نفّذ الأوامر في **PowerShell**.

## 1. تثبيت المتطلبات (مرة واحدة لكل جهاز)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id PostgreSQL.PostgreSQL.17 -e --interactive
```

- `--interactive` يفتح نافذة تثبيت PostgreSQL، وستطلب منك **كلمة مرور للمستخدم `postgres`**. اخترها واحفظها. باقي الخيارات اتركها على الافتراضي (المنفذ 5432).
- بعد التثبيت **أغلق PowerShell وافتحه من جديد** حتى تُعرف الأوامر الجديدة.

تحقق:

```powershell
node --version        # يجب أن يكون v24 أو أحدث
git --version
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" --version
```

## 2. إنشاء مستخدم التطبيق وقاعدتَي البيانات (مرة واحدة)

اختر كلمة مرور لمستخدم التطبيق `commerce_app`: حروف وأرقام إنجليزية فقط، لتجنّب مشاكل الرموز في الروابط. ثم نفّذ، وسيطلب منك كلمة مرور `postgres`:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -h localhost -U postgres -d postgres `
  -c "CREATE ROLE commerce_app LOGIN PASSWORD 'ضع_كلمة_المرور_هنا';" `
  -c "CREATE DATABASE commerce_dev OWNER commerce_app;" `
  -c "CREATE DATABASE commerce_test OWNER commerce_app;"
```

- `commerce_dev`: للتطوير والتجربة اليدوية.
- `commerce_test`: للاختبارات، **وتُمسح في كل تشغيل للاختبارات**.

## 3. تنزيل المشروع

المستودع خاص، فيجب أن يضيفك صاحبه كـ Collaborator أولاً:
GitHub ← صفحة المستودع ← Settings ← Collaborators ← Add people.

```powershell
cd $HOME\Desktop
git clone https://github.com/AWELY/backend-framework.git
cd backend-framework
```

عند أول `clone` تفتح نافذة لتسجيل الدخول إلى GitHub.

## 4. الإعداد

```powershell
npm install
npm run setup -- --db-password ضع_كلمة_مرور_commerce_app
npm run build
npm run migrate
```

- `npm run setup`: ينشئ ملف `.env` بمفاتيح سرية عشوائية، وبروابط قاعدتَي البيانات.
- `npm run migrate`: ينشئ الجداول في `commerce_dev`.

## 5. الاختبار الكامل

```powershell
npm run verify
```

النتيجة المتوقعة في النهاية:

```
PASS  prerequisites
PASS  build (TypeScript)
PASS  unit + integration tests
PASS  CLI: create a store, install, migrate, start, call it
PASS  demo store: migrate, seed, start, 16-step scenario
ALL CHECKS PASSED
```

## 6. التجربة اليدوية

```powershell
npm start
```

ثم في نافذة أخرى:

```powershell
curl.exe http://localhost:3000/health
```

كل المسارات في `docs/API.md`.

## مشاكل شائعة

| الرسالة | السبب والحل |
|---|---|
| `node` غير معروف، أو إصدار أقدم من 24 | أغلق PowerShell وافتحه من جديد بعد التثبيت |
| `password authentication failed for user "commerce_app"` | كلمة المرور في `.env` لا تطابق التي وضعتها في الخطوة 2. عدّل `DATABASE_URL` و`TEST_DATABASE_URL` في `.env` |
| `Cannot reach the test database` | خدمة PostgreSQL متوقفة: `Start-Service postgresql-x64-17` (أو من تطبيق Services) |
| `OWNER_API_KEY must be a random value of at least 32 characters` | ملف `.env` فيه القيم الافتراضية. احذفه ونفّذ `npm run setup` من جديد |
| `.env already exists` | `npm run setup` لا يكتب فوق ملف موجود. احذف `.env` إن أردت إعادة إنشائه |
| `Registration limit reached` في رحلة الشراء التجريبية | الحد 5 حسابات في الساعة لكل عنوان. أعد تشغيل خادم المتجر التجريبي |
