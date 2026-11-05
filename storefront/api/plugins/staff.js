const { randomBytes } = require("node:crypto");
const {
  createToken,
  hashPassword,
  verifyPassword,
  signToken,
  validateBody,
  requirePermission,
  FailureLimiter,
  isUuid,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} = require("commerce-framework");
const { query, PHONE, EMAIL } = require("./shared");

/**
 * إضافة "حسابات الموظفين": مدير المتجر (admin) ومندوب التوصيل (courier).
 *
 * لماذا لا يكفي مفتاح المالك (OWNER_API_KEY)؟ لأنه مفتاح واحد بكل الصلاحيات، يناسب Postman
 * والسكربتات، لكن لا يناسب موقعاً حقيقياً: لا يمكن إعطاؤه لمندوب، ولا معرفة من فعل ماذا، ولا
 * سحبه من موظف واحد دون تغييره للجميع. لهذا لكل موظف حساب ببريد وكلمة مرور ودور.
 *
 * كيف تعمل مع الإطار دون تعديله؟
 *   - الدخول يصدر توكناً موقّعاً بنفس سر الإطار (signToken)، فيه الدور "admin" أو "courier".
 *     مصادقة الإطار (createAuthenticator) تقبل أي توكن موقّع بهذا السر، وتضع الدور في req.auth.
 *   - ماذا يحق لكل دور؟ يحدده جدول الصلاحيات الذي يمرره المتجر للإطار (ROLES في app.js).
 *     فمسارات الإطار نفسها (مثل PATCH /orders/:id/status) تقبل المدير تلقائياً.
 *
 * المسارات:
 *   POST  /staff/login   عام: { email, password } ويرد { staff, token }
 *   GET   /staff/me      الموظف المسجل دخوله: بياناته
 *   GET   /staff?role=   staff:manage (المدير): قائمة الموظفين، أو المندوبين فقط بـ ?role=courier
 *   POST  /staff         staff:manage: إنشاء حساب موظف
 *   PATCH /staff/:id     staff:manage: تعديل الاسم أو الهاتف أو كلمة المرور، أو إيقاف الحساب
 *
 * قيد معروف (من طبيعة التوكن في الإطار): إيقاف حساب لا يلغي توكنه فوراً في مسارات الإطار.
 * لهذا مدة توكن الموظف قصيرة (12 ساعة)، ومسارات الإضافات نفسها تفحص الحساب في القاعدة مع كل
 * طلب (activeStaff أدناه)، فالمندوب الموقوف لا يستطيع تنفيذ أي عملية توصيل.
 */

/** الدوران الوحيدان المسموحان للموظفين. CHECK في الجدول يفرض نفس القائمة. */
const STAFF_ROLES = ["admin", "courier"];

const staffMigrations = [
  {
    // أرقام migrations الإضافات تبدأ من 9000، فتُطبَّق دائماً بعد جداول الإطار.
    // الفهرس الفريد على lower(email): "Ali@x.ly" و "ali@x.ly" حساب واحد، كما في جدول الزبائن.
    id: "9100_create_staff",
    up: `
      CREATE TABLE staff (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'courier')),
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX staff_email_key ON staff (lower(email));
    `,
  },
];

// قواعد التحقق، بنفس صيغة الإطار (validateBody). الحقل غير المذكور هنا يُرفض بـ 400.
const loginSchema = {
  email: { type: "string", maxLength: 254 },
  password: { type: "string", maxLength: 128 },
};
const createSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  email: { type: "string", maxLength: 254, pattern: EMAIL },
  // الحد الأعلى يمنع إرسال "كلمة مرور" ضخمة تجعل الخادم يحسب hash طويلاً.
  password: { type: "string", minLength: 8, maxLength: 128 },
  phone: { type: "string", maxLength: 30, pattern: PHONE, optional: true },
  role: { type: "string", oneOf: STAFF_ROLES },
};
// للتعديل (PATCH) مع partial: true، فكل حقل اختياري. البريد والدور لا يتغيران بعد الإنشاء.
const updateSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE },
  password: { type: "string", minLength: 8, maxLength: 128 },
  isActive: { type: "boolean" },
};

/** يوحّد البريد قبل الحفظ والبحث (حروف صغيرة بلا مسافات)، كما يفعل الإطار مع الزبائن. */
const normalizeEmail = (email) => email.trim().toLowerCase();

/** قراءة جدول الموظفين وكتابته. لا يرجع password_hash أبداً إلا في findCredentials. */
class StaffRepository {
  constructor(db) {
    this.db = db;
  }

  /** صف القاعدة (snake_case) إلى شكل الـ API (camelCase)، دون كلمة المرور. */
  toStaff(row) {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }

  /** موظف برقمه، أو null. رقم ليس UUID يعطي null مباشرة بدل خطأ من القاعدة. */
  async findById(id) {
    if (!isUuid(id)) return null;
    const { rows } = await query(this.db, "SELECT * FROM staff WHERE id = $1", [id]);
    return rows[0] ? this.toStaff(rows[0]) : null;
  }

  /** للدخول فقط: الموظف مع hash كلمة المرور، أو null إن لم يوجد البريد. */
  async findCredentials(email) {
    const { rows } = await query(this.db, "SELECT * FROM staff WHERE lower(email) = $1", [email]);
    return rows[0] ? { staff: this.toStaff(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  /** كل الموظفين، أو دور واحد. النشطون أولاً، ثم بالاسم. */
  async list(role) {
    const { rows } = role
      ? await query(this.db, "SELECT * FROM staff WHERE role = $1 ORDER BY is_active DESC, name", [role])
      : await query(this.db, "SELECT * FROM staff ORDER BY role, is_active DESC, name");
    return rows.map((r) => this.toStaff(r));
  }

  /** ينشئ حساباً. البريد المكرر ترفضه القاعدة (الفهرس الفريد)، فيصبح الرد 409. */
  async create({ email, passwordHash, name, phone, role }) {
    const { rows } = await query(
      this.db,
      `INSERT INTO staff (email, password_hash, name, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, passwordHash, name, phone ?? null, role]
    );
    return this.toStaff(rows[0]);
  }

  /**
   * تعديل جزئي: فقط الحقول المرسلة. نبني "SET" من قائمة ثابتة كتبناها نحن (COLUMNS)، لا من
   * أسماء الحقول القادمة من الطلب، فلا يمكن حقن اسم عمود. القيم نفسها تبقى $1 و $2 ...
   */
  async update(id, fields) {
    if (!isUuid(id)) return null;
    const COLUMNS = { name: "name", phone: "phone", isActive: "is_active", passwordHash: "password_hash" };
    const sets = [];
    const values = [id];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (fields[key] === undefined) continue;
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);
    const { rows } = await query(
      this.db,
      `UPDATE staff SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      values
    );
    return rows[0] ? this.toStaff(rows[0]) : null;
  }
}

/** رمز المستودع في حاوية الـ DI: إضافة التوصيل تطلبه منها لتتأكد أن المندوب ما زال نشطاً. */
const STAFF_REPOSITORY = createToken("StaffRepository");

/**
 * الموظف صاحب الطلب الحالي، بعد التأكد من القاعدة أنه موجود ونشط وبنفس الدور الذي في توكنه.
 * roles: الأدوار المقبولة لهذا المسار، مثل ["courier"].
 *
 * الحساب الموقوف أو المحذوف يعطي 401 "Invalid or expired token"، وهي نفس رسالة التوكن المنتهي،
 * فيمسح الموقع الجلسة ويعيد الموظف إلى صفحة الدخول.
 */
async function activeStaff(repo, req, roles = STAFF_ROLES) {
  if (!req.auth?.userId || !roles.includes(req.auth.role)) {
    throw new ForbiddenError(`Requires role: ${roles.join(" or ")}`);
  }
  const staff = await repo.findById(req.auth.userId);
  if (!staff || !staff.isActive || staff.role !== req.auth.role) throw new UnauthorizedError("Invalid or expired token");
  return staff;
}

/**
 * معالج وسيط (middleware) لمسارات المدير في الإضافات: يتأكد أن المدير ما زال نشطاً في القاعدة.
 * يوضع بعد requirePermission في السلسلة. مفتاح المالك (role: owner) ليس له صف في جدول
 * الموظفين، فيمر مباشرة. getRepo دالة ترجع المستودع من الحاوية عند كل طلب.
 *
 * دالة async تستدعي next: سلسلة المعالجات في الإطار (runPipeline) تلتقط أي خطأ ترميه.
 */
function activeAdminGuard(getRepo) {
  return async (req, _res, next) => {
    if (req.auth?.role !== "owner") await activeStaff(getRepo(), req, ["admin"]);
    next();
  };
}

/**
 * الإضافة نفسها. tokenSecret هو نفس AUTH_TOKEN_SECRET الذي يعطيه المتجر للإطار، ليقبل الإطار
 * توكنات الموظفين. المتجر يملك هذا السر أصلاً (في .env)، فإعطاؤه لإضافته لا يكشف شيئاً جديداً.
 */
function staffAccounts({ tokenSecret, tokenTtlSeconds = 12 * 60 * 60 }) {
  if (!tokenSecret) throw new Error("staffAccounts: tokenSecret is required");
  // عدّاد محاولات الدخول الفاشلة: 8 كل 15 دقيقة، لكل عنوان ولكل بريد. نفس أداة الإطار للزبائن،
  // لكن بعدّاد مستقل، فمحاولات الدخول على حسابات الموظفين لا تختلط بحسابات الزبائن.
  const loginLimiter = new FailureLimiter({ maxFailures: 8, windowSeconds: 15 * 60 });
  // hash وهمي للبريد غير الموجود: نتحقق مقابله فيستغرق الرد نفس الوقت، فلا يكشف زمن الرد
  // أي البريدات مسجلة (نفس فكرة verifyAgainstDummy في الإطار).
  let dummyHash;

  return {
    name: "staff-accounts",
    migrations: staffMigrations,
    setup({ router, container, pool, accessControl, authenticate, clientIp }) {
      container.register(STAFF_REPOSITORY, () => new StaffRepository(pool));
      const repo = () => container.resolve(STAFF_REPOSITORY);
      const canManage = requirePermission(accessControl, "staff:manage");

      const ensureActive = activeAdminGuard(repo);

      // الدخول. نفس خطوات دخول الزبائن في الإطار: فحص الحظر أولاً (قبل حساب hash المكلف)، ثم
      // التحقق، ونفس الرسالة للبريد غير الموجود ولكلمة المرور الخاطئة.
      router.post("/staff/login", validateBody(loginSchema), async (req, res) => {
        const email = normalizeEmail(req.body.email);
        const keys = [`ip:${clientIp(req)}`, `email:${email}`];
        const wait = Math.max(...keys.map((key) => loginLimiter.retryAfter(key)));
        if (wait > 0) throw new TooManyRequestsError("Too many failed login attempts. Try again later.", wait);

        const record = await repo().findCredentials(email);
        dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
        const ok = await verifyPassword(req.body.password, record ? record.passwordHash : await dummyHash);
        if (!record || !ok) {
          for (const key of keys) loginLimiter.recordFailure(key);
          throw new UnauthorizedError("Invalid email or password");
        }
        // كلمة المرور صحيحة لكن الحساب موقوف: نقول ذلك صراحة، فهو يعرف كلمة المرور أصلاً.
        if (!record.staff.isActive) throw new ForbiddenError("This account is disabled");
        loginLimiter.reset(`email:${email}`);
        const token = signToken({ sub: record.staff.id, role: record.staff.role }, tokenSecret, tokenTtlSeconds);
        res.json({ staff: record.staff, token });
      });

      // بيانات الموظف المسجل دخوله (تستخدمها لوحة التحكم وتطبيق المندوب عند فتح أي صفحة).
      router.get("/staff/me", authenticate, async (req, res) => {
        res.json(await activeStaff(repo(), req));
      });

      // قائمة الموظفين للمدير. ?role=courier تعطي المندوبين فقط (لقائمة "تعيين مندوب").
      router.get("/staff", authenticate, canManage, ensureActive, async (req, res) => {
        const role = req.query.get("role");
        res.json(await repo().list(STAFF_ROLES.includes(role) ? role : undefined));
      });

      // إنشاء حساب. نحفظ hash كلمة المرور فقط، لا الكلمة نفسها.
      router.post("/staff", authenticate, canManage, ensureActive, validateBody(createSchema), async (req, res) => {
        const { password, email, ...rest } = req.body;
        const staff = await repo().create({ ...rest, email: normalizeEmail(email), passwordHash: await hashPassword(password) });
        res.status(201).json(staff);
      });

      // تعديل حساب. المدير لا يستطيع إيقاف حسابه هو، حتى لا يُغلق المتجر على نفسه بالخطأ.
      router.patch(
        "/staff/:id",
        authenticate,
        canManage,
        ensureActive,
        validateBody(updateSchema, { partial: true }),
        async (req, res) => {
          const { password, ...rest } = req.body;
          // نقارن بحروف صغيرة: القاعدة تقبل UUID بحروف كبيرة أيضاً، فلا يتجاوز أحد الشرط بتغيير حالة الحروف.
          if (rest.isActive === false && req.params.id.toLowerCase() === req.auth.userId?.toLowerCase()) {
            throw new ConflictError("You cannot disable your own account");
          }
          const fields = password ? { ...rest, passwordHash: await hashPassword(password) } : rest;
          const staff = await repo().update(req.params.id, fields);
          if (!staff) throw new NotFoundError("Staff member not found");
          res.json(staff);
        }
      );
    },
  };
}

module.exports = {
  staffAccounts,
  StaffRepository,
  STAFF_REPOSITORY,
  STAFF_ROLES,
  activeStaff,
  activeAdminGuard,
  normalizeEmail,
  createSchema,
};
