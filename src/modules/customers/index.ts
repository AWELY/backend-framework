import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from "../../engine/errors";
import { hashPassword, verifyPassword, verifyAgainstDummy } from "../../engine/password";
import { found, parsePagination } from "../shared";
import {
  customersMigrations,
  registerSchema,
  loginSchema,
  profileSchema,
  normalizeEmail,
  type RegisterInput,
  type LoginInput,
  type ProfileInput,
} from "./customers.schema";
import { CustomersRepository, CUSTOMERS_REPOSITORY } from "./customers.repository";

/**
 * وحدة حسابات الزبائن. الحساب اختياري: الضيف يستطيع الشراء بدون حساب.
 * هنا تلتقي كل أدوات الأمان: hash كلمة المرور، وحد المحاولات، والتوكن، والصلاحيات.
 *
 * المسارات:
 *   POST  /customers/register   عام، ويرد 201 بـ { customer, token }
 *   POST  /customers/login      عام، ويرد بـ { customer, token }
 *   GET   /customers/me         الزبون المسجل دخوله: ملفه الشخصي
 *   PATCH /customers/me         profile:manage، بجسم { name?, phone? }
 *   GET   /customers            customers:read (المالك): كل الزبائن
 *   GET   /customers/:id        customers:read (المالك): زبون واحد
 *
 * بعد التسجيل أو الدخول، يرسل الموقع التوكن مع كل طلب تالٍ في الترويسة:
 *   Authorization: Bearer <token>
 */
export const customersModule: CommerceModule = {
  name: "customers",
  migrations: customersMigrations,

  register({
    router,
    container,
    pool,
    accessControl,
    authenticate,
    issueCustomerToken,
    loginLimiter,
    registrationLimiter,
    clientIp,
  }) {
    container.register(CUSTOMERS_REPOSITORY, () => new CustomersRepository(pool));
    const repo = () => container.resolve(CUSTOMERS_REPOSITORY);
    const canRead = requirePermission(accessControl, "customers:read");

    /**
     * رقم الزبون المسجل دخوله، من التوكن. المالك ليس له ملف زبون، فيحصل على 403.
     * الملف الشخصي يُقرأ دائماً من التوكن، لا من الرابط: لا يستطيع زبون فتح ملف غيره.
     */
    const selfId = (req: AppRequest): string => {
      if (req.auth?.role !== "customer" || !req.auth.userId) {
        throw new ForbiddenError("Only a logged-in customer has a profile");
      }
      return req.auth.userId;
    };

    /**
     * التسجيل. محدود لكل عنوان IP (5 في الساعة افتراضياً): كل محاولة تصل إلى حساب hash كلمة
     * المرور تُعدّ، حتى المحاولة ببريد مكرر، لأنها كلفت الخادم حساب hash أيضاً.
     * الجسم غير الصالح يرفضه validateBody قبل هذا الكود، فالأخطاء المطبعية لا تُعدّ.
     *
     * الفحص والعدّ يحدثان مباشرة، قبل أي await. لماذا؟ لو كان بينهما await، لاستطاع سيل من
     * الطلبات المتوازية أن يمر كله من الفحص قبل أن يُعدّ أي واحد منها.
     */
    router.post("/customers/register", validateBody(registerSchema), async (req, res) => {
      if (registrationLimiter) {
        const key = `ip:${clientIp(req)}`;
        const wait = registrationLimiter.retryAfter(key);
        if (wait > 0) throw new TooManyRequestsError("Too many accounts created from this address. Try again later.", wait);
        registrationLimiter.recordAttempt(key);
      }
      const input = req.body as RegisterInput;
      // نحفظ hash كلمة المرور فقط، لا الكلمة نفسها. البريد يُوحَّد (حروف صغيرة بلا مسافات).
      // بريد مسجل من قبل يجعل القاعدة ترفض (فهرس UNIQUE)، فيصبح الرد 409.
      const customer = await repo().create({
        email: normalizeEmail(input.email),
        passwordHash: await hashPassword(input.password),
        name: input.name,
        phone: input.phone,
      });
      // المستخدم الجديد يدخل مباشرة: نرسل له توكناً مع بياناته.
      res.status(201).json({ customer, token: issueCustomerToken(customer.id) });
    });

    /**
     * الدخول. محدود لكل عنوان IP ولكل بريد معاً (المحاولات الفاشلة فقط، 10 كل 15 دقيقة).
     *
     * الفحص يحدث قبل حساب hash كلمة المرور، فالمرسل المحظور لا يكلف الخادم شيئاً تقريباً.
     *
     * الدخول الناجح يمسح عدّاد البريد، لكن لا يمسح عدّاد العنوان. السبب: لو مُسح عدّاد العنوان
     * أيضاً، لاستطاع المهاجم أن يدخل حسابه هو بين كل بضع محاولات، فيصفّر عدّاده ويخمّن بلا نهاية.
     */
    router.post("/customers/login", validateBody(loginSchema), async (req, res) => {
      const { email, password } = req.body as LoginInput;
      const normalized = normalizeEmail(email);
      const keys = [`ip:${clientIp(req)}`, `email:${normalized}`];

      // 1. هل أحد المفتاحين محظور؟ ننتظر الأطول بينهما.
      if (loginLimiter) {
        const wait = Math.max(...keys.map((key) => loginLimiter.retryAfter(key)));
        if (wait > 0) throw new TooManyRequestsError("Too many failed login attempts. Try again later.", wait);
      }

      // 2. نبحث عن الحساب ونتحقق من كلمة المرور. إن لم يوجد الحساب، نستهلك نفس الوقت بتحقق
      //    وهمي، فلا يكشف زمن الرد أن البريد غير مسجل (engine/password.ts).
      const record = await repo().findCredentials(normalized);
      const ok = record ? await verifyPassword(password, record.passwordHash) : await verifyAgainstDummy(password);
      // 3. نفس الرسالة للبريد غير الموجود ولكلمة المرور الخاطئة: الرد يجب ألا يخبر المهاجم
      //    أي البريدات مسجلة عندنا.
      if (!record || !ok) {
        for (const key of keys) loginLimiter?.recordFailure(key);
        throw new UnauthorizedError("Invalid email or password");
      }
      // 4. نجح: نمسح عدّاد البريد فقط، ونرسل التوكن. "?." لأن loginLimiter قد يكون null.
      loginLimiter?.reset(`email:${normalized}`);
      res.json({ customer: record.customer, token: issueCustomerToken(record.customer.id) });
    });

    // ملفي الشخصي. مسجّل قبل "/customers/:id" عمداً: أول مسار يطابق يفوز، ولو كان بعده
    // لذهب الطلب إلى مسار :id بقيمة "me".
    router.get("/customers/me", authenticate, async (req, res) => {
      res.json(found(await repo().findById(selfId(req)), "Customer"));
    });

    // تعديل الاسم أو الهاتف. البريد وكلمة المرور ليسا في profileSchema، فلا يمكن تعديلهما هنا.
    router.patch(
      "/customers/me",
      authenticate,
      requirePermission(accessControl, "profile:manage"),
      validateBody(profileSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().updateProfile(selfId(req), req.body as Partial<ProfileInput>), "Customer"));
      }
    );

    // للمالك: قائمة الزبائن، مع الترقيم.
    router.get("/customers", authenticate, canRead, async (req, res) => {
      res.json(await repo().findAll(parsePagination(req.query)));
    });

    // للمالك: زبون واحد.
    router.get("/customers/:id", authenticate, canRead, async (req, res) => {
      res.json(found(await repo().findById(req.params.id as string), "Customer"));
    });
  },
};
