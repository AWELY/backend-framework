# تشغيل المشروع على Linux (Ubuntu / Debian)

الأوامر لـ Ubuntu وDebian وما يشبههما. لتوزيعات أخرى انظر آخر الملف. نفّذها في الطرفية (Terminal).

## 1. تثبيت Node.js 24 وGit

`nodejs` الموجود في مستودعات Ubuntu الافتراضية قديم، فنثبّت الإصدار 24 من NodeSource:

```bash
sudo apt-get update
sudo apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version        # يجب أن يكون v24 أو أحدث
```

## 2. تثبيت PostgreSQL

```bash
sudo apt-get install -y postgresql
psql --version
```

- الخدمة تبدأ تلقائياً.
- **أي إصدار من 14 فما فوق يعمل.** Ubuntu 24.04 يثبّت 16، وUbuntu 22.04 يثبّت 14، وDebian 12 يثبّت 15.
- على Linux **لا تحتاج كلمة مرور للمستخدم `postgres`**: نستخدم `sudo` بدلها.

## 3. إنشاء مستخدم التطبيق وقاعدتَي البيانات

اختر كلمة مرور لمستخدم التطبيق (**حروف وأرقام إنجليزية فقط**) وضعها مكان `MyPass123`:

```bash
cd /tmp
sudo -u postgres psql -c "CREATE ROLE commerce_app LOGIN PASSWORD 'MyPass123';" \
  -c "CREATE DATABASE commerce_dev OWNER commerce_app;" \
  -c "CREATE DATABASE commerce_test OWNER commerce_app;"
sudo -u postgres psql -d commerce_dev  -c "ALTER SCHEMA public OWNER TO commerce_app;"
sudo -u postgres psql -d commerce_test -c "ALTER SCHEMA public OWNER TO commerce_app;"
```

- `cd /tmp` يتجنب تحذيراً غير مضر: `could not change directory`.
- **السطران الأخيران ضروريان على PostgreSQL 14 وما قبله.** هناك يملك `postgres` المخطط الافتراضي `public`، فتفشل الاختبارات عند مسح قاعدة الاختبار بدونهما. على الإصدارات الأحدث لا يضرّان.

النجاح يظهر: `CREATE ROLE` ثم `CREATE DATABASE` مرتين ثم `ALTER SCHEMA` مرتين.

## 4. تسجيل الدخول إلى GitHub وتنزيل المشروع

المستودع خاص، ويجب أن يكون صاحبه قد أضافك كـ Collaborator **وقبلتَ الدعوة**. على Linux لا يقبل GitHub كلمة المرور العادية في الطرفية، فنستخدم أداة `gh` الرسمية:

```bash
sudo apt-get install -y gh
gh auth login
```

اختر بالترتيب: **GitHub.com** ← **HTTPS** ← **Yes** (لربط Git بحسابك) ← **Login with a web browser**. سيعطيك رمزاً تُدخله في المتصفح. ثم:

```bash
cd ~
gh repo clone AWELY/backend-framework
cd backend-framework
```

إن لم تتوفر حزمة `gh` في توزيعتك، راجع الملاحظات في آخر الملف.

## 5. الإعداد

ضع كلمة مرور `commerce_app` من الخطوة 3 مكان `MyPass123`:

```bash
npm install
npm run setup -- --db-password MyPass123
npm run build
npm run migrate
```

آخر أمر يجب أن ينتهي بـ `Done: 7 migration(s) applied.`

## 6. الاختبار الكامل

```bash
npm run verify
```

إن ظهر في النهاية **`ALL CHECKS PASSED`**، فالمشروع يعمل على جهازك بالكامل.

## 7. تشغيل متجر AMA (اختياري)

الفحص السابق يختبر المتجر على قاعدة الاختبار. لتشغيله وتصفّحه فعلياً، اتبع `storefront/README.md`. يحتاج قاعدة خاصة به:

```bash
cd /tmp && sudo -u postgres psql -c "CREATE DATABASE ama_store OWNER commerce_app;"
sudo -u postgres psql -d ama_store -c "ALTER SCHEMA public OWNER TO commerce_app;"
```

## مشاكل شائعة

| الرسالة | الحل |
|---|---|
| `must be owner of schema public` | لم تنفّذ سطرَي `ALTER SCHEMA` في الخطوة 3 |
| `password authentication failed for user "commerce_app"` | كلمة المرور في `setup` لا تطابق الخطوة 3. نفّذ `rm .env` ثم أعد `npm run setup` |
| `Cannot reach the test database` أو `ECONNREFUSED` | الخدمة متوقفة: `sudo systemctl start postgresql` |
| `node: command not found` أو إصدار أقدم من 24 | أعد الخطوة 1، ثم افتح طرفية جديدة |
| `Repository not found` | لم تقبل دعوة المستودع، أو سجّلت الدخول في `gh` بحساب آخر (`gh auth status`) |
| `could not change directory to "/home/..."` | تحذير غير مضر من `sudo -u postgres`. نفّذ `cd /tmp` قبله |

## توزيعات أخرى

- **Node.js 24 على أي توزيعة**، عبر nvm بلا `sudo`:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  source ~/.bashrc
  nvm install 24
  ```
- **Fedora:**
  ```bash
  sudo dnf install postgresql-server git gh
  sudo postgresql-setup --initdb
  sudo systemctl enable --now postgresql
  ```
  على Fedora قد يرفض PostgreSQL الدخول بكلمة مرور عبر `localhost` افتراضياً، لأن ملف `pg_hba.conf` يستخدم طريقة `ident`. غيّرها إلى `scram-sha-256` في السطرين الخاصين بـ `127.0.0.1/32` و`::1/128`، ثم `sudo systemctl restart postgresql`.
- **Arch:**
  ```bash
  sudo pacman -S nodejs npm postgresql git github-cli
  ```
  ثم هيّئ PostgreSQL حسب ويكي Arch.
- **بلا `gh`:** أنشئ Personal Access Token من GitHub (Settings ← Developer settings ← Personal access tokens) واستخدمه مكان كلمة المرور عند `git clone https://github.com/AWELY/backend-framework.git`.
