import { createHash, randomBytes } from "node:crypto";
import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { withTransaction } from "../../db/transaction";
import {
  ErrorCodes,
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../../engine/errors";
import { hashPassword, verifyPassword, verifyAgainstDummy } from "../../engine/password";
import { found, sendPage, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import { CartRepository } from "../cart/cart.repository";
import {
  customersMigrations,
  registerSchema,
  loginSchema,
  profileSchema,
  passwordChangeSchema,
  resetRequestSchema,
  resetConfirmSchema,
  customerListQuery,
  normalizeEmail,
} from "./customers.schema";
import { CustomersRepository, CUSTOMERS_REPOSITORY } from "./customers.repository";

/** مدة صلاحية رمز استعادة كلمة المرور بالدقائق. */
const RESET_TTL_MINUTES = 30;

/** بصمة رمز الاستعادة كما تُحفظ في القاعدة. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * وحدة الزبائن: الحساب، والدخول، والجلسات، واستعادة كلمة المرور.
 *
 * المسارات:
 *   POST  /customers/register                 يُنشئ حساباً ويرجع { customer, token, cartId? }. حد لكل IP
 *   POST  /customers/login                    يرجع { customer, token, cartId? }. حد لكل IP ولكل بريد
 *   POST  /customers/logout                   يُلغي جلسة هذا الجهاز (204)
 *   POST  /customers/logout-all               يُلغي كل جلسات الحساب (204)
 *   GET   /customers/me                       الملف الشخصي
 *   PATCH /customers/me                       تعديل الاسم والهاتف (phone: null يمسحه)
 *   GET   /customers/me/sessions              الأجهزة الداخلة الآن
 *   POST  /customers/me/password              تغيير كلمة المرور (يُخرج كل الأجهزة الأخرى)
 *   POST  /customers/password-reset           يطلب رمز استعادة (202 دائماً، حتى لبريد غير مسجل)
 *   POST  /customers/password-reset/confirm   كلمة مرور جديدة بالرمز (يُخرج كل الأجهزة)
 *   GET   /customers                          customers:read. ?q= بحث، والعدد في X-Total-Count
 *   GET   /customers/:id                      customers:read
 *
 * guestCartId في التسجيل والدخول: سلة الضيف تُدمج في سلة الزبون (cartId في الرد هو السلة الناتجة).
 *
 * لماذا 202 دائماً في طلب الاستعادة؟ لو رد "هذا البريد غير مسجل"، لعرف أي أحد أي البريدات
 * عندنا (Account enumeration). الرمز يصل للزبون عبر الحدث customer.passwordResetRequested، وإضافة
 * (بريد أو رسائل) ترسله. الإطار لا يرسل بريداً بنفسه.
 */
export const customersModule: CommerceModule = {
  name: "customers",
  migrations: customersMigrations,

  register({ router, container, pool, accessControl, authenticate, sessions, limiters, clientIp, events, logger }) {
    container.register(CUSTOMERS_REPOSITORY, () => new CustomersRepository(pool));
    const repo = () => container.resolve(CUSTOMERS_REPOSITORY);
    const canRead = requirePermission(accessControl, "customers:read");

    /** رقم الزبون الداخل، أو 403 إن كان المرسل ليس زبوناً (المالك أو موظف ليس له ملف زبون). */
    const selfId = (req: AppRequest): string => {
      if (req.auth?.principal !== "customer" || !req.auth.userId) {
        throw new ForbiddenError("Only a logged-in customer has a profile");
      }
      return req.auth.userId;
    };

    /** يفحص حداً قبل العمل المكلف: 429 إن كان أي مفتاح محظوراً. */
    async function checkLimit(
      limiter: (typeof limiters)[keyof typeof limiters],
      keys: string[],
      message: string
    ): Promise<void> {
      if (!limiter) return;
      const waits = await Promise.all(keys.map((k) => limiter.retryAfter(k)));
      const wait = Math.max(0, ...waits);
      if (wait > 0) throw new TooManyRequestsError(message, wait);
    }

    /** ينشئ جلسة دخول، ويدمج سلة الضيف إن أُرسلت. */
    async function signIn(req: AppRequest, customerId: string, guestCartId?: string) {
      const { token } = await sessions.issue(
        { type: "customer", id: customerId, role: "customer" },
        { ip: clientIp(req), userAgent: req.headers["user-agent"] }
      );
      const cartId = guestCartId ? await CartRepository.mergeGuestCart(pool, guestCartId, customerId).catch(() => null) : null;
      return { token, ...(guestCartId ? { cartId } : {}) };
    }

    router.post(
      "/customers/register",
      withInput({ body: registerSchema, summary: "Create a customer account", successStatus: 201 }, async (req, res, { body }) => {
        if (limiters.registration) {
          const wait = await limiters.registration.consume(`ip:${clientIp(req)}`);
          if (wait > 0) throw new TooManyRequestsError("Too many accounts created from this address. Try again later.", wait);
        }
        const passwordHash = await hashPassword(body.password);
        const customer = await withTransaction(pool, async (client) => {
          const created = await new CustomersRepository(client).create({
            email: normalizeEmail(body.email),
            passwordHash,
            name: body.name,
            phone: body.phone,
          });
          await events.publish(client, "customer.registered", { customer: created });
          return created;
        });
        events.notify();
        res.status(201).json({ customer, ...(await signIn(req, customer.id, body.guestCartId)) });
      })
    );

    /**
     * الدخول. الحد يُفحص أولاً، قبل حساب hash كلمة المرور (العمل المكلف): بعد الحظر، كل محاولة
     * إضافية تكلف الخادم شبه لا شيء. البريد غير المسجل يمر بنفس زمن التحقق (verifyAgainstDummy)،
     * فلا يكشف زمن الرد أي البريدات مسجلة.
     */
    router.post(
      "/customers/login",
      withInput({ body: loginSchema, summary: "Log in as a customer" }, async (req, res, { body }) => {
        const normalized = normalizeEmail(body.email);
        const keys = [`ip:${clientIp(req)}`, `email:${normalized}`];
        await checkLimit(limiters.login, keys, "Too many failed login attempts. Try again later.");

        const record = await repo().findCredentials(normalized);
        const ok = record ? await verifyPassword(body.password, record.passwordHash) : await verifyAgainstDummy(body.password);
        if (!record || !ok) {
          for (const key of keys) await limiters.login?.recordFailure(key);
          throw new UnauthorizedError("Invalid email or password", ErrorCodes.INVALID_CREDENTIALS);
        }
        // نجح الدخول: يُمسح عدّاد البريد (صاحبه دخل)، لا عدّاد العنوان (قد يجرب المهاجم بريدات أخرى منه).
        await limiters.login?.reset(`email:${normalized}`);
        res.json({ customer: record.customer, ...(await signIn(req, record.customer.id, body.guestCartId)) });
      })
    );

    router.post(
      "/customers/logout",
      authenticate,
      withInput({ summary: "Log out of this device", successStatus: 204 }, async (req, res) => {
        selfId(req);
        if (req.auth?.sessionId) await sessions.revoke(req.auth.sessionId);
        res.status(204).end();
      })
    );

    router.post(
      "/customers/logout-all",
      authenticate,
      withInput({ summary: "Log out of every device", successStatus: 204 }, async (req, res) => {
        await sessions.revokeAll("customer", selfId(req));
        res.status(204).end();
      })
    );

    router.get(
      "/customers/me",
      authenticate,
      withInput({ summary: "The logged-in customer's profile" }, async (req, res) => {
        res.json(found(await repo().findById(selfId(req)), "Customer"));
      })
    );

    router.patch(
      "/customers/me",
      authenticate,
      requirePermission(accessControl, "profile:manage"),
      withInput({ body: profileSchema, partial: true, summary: "Update the profile" }, async (req, res, { body }) => {
        res.json(found(await repo().updateProfile(selfId(req), body), "Customer"));
      })
    );

    router.get(
      "/customers/me/sessions",
      authenticate,
      withInput({ summary: "Active sessions of the logged-in customer" }, async (req, res) => {
        const id = selfId(req);
        const list = await sessions.list("customer", id);
        res.json(list.map((s) => ({ ...s, current: s.id === req.auth?.sessionId })));
      })
    );

    router.post(
      "/customers/me/password",
      authenticate,
      withInput({ body: passwordChangeSchema, summary: "Change the password", successStatus: 204 }, async (req, res, { body }) => {
        const id = selfId(req);
        const stored = await repo().passwordHashOf(id);
        if (!stored || !(await verifyPassword(body.currentPassword, stored))) {
          throw new ValidationError("Validation failed", [{ field: "currentPassword", message: "is incorrect" }], ErrorCodes.INVALID_CREDENTIALS);
        }
        await repo().setPassword(id, await hashPassword(body.newPassword));
        // هذا الجهاز يبقى داخلاً، وكل الأجهزة الأخرى تخرج (ربما كانت بيد من عرف كلمة المرور القديمة).
        await sessions.revokeAll("customer", id, { exceptSessionId: req.auth?.sessionId });
        res.status(204).end();
      })
    );

    router.post(
      "/customers/password-reset",
      withInput({ body: resetRequestSchema, summary: "Request a password reset code", successStatus: 202 }, async (req, res, { body }) => {
        const email = normalizeEmail(body.email);
        const keys = [`ip:${clientIp(req)}`, `email:${email}`];
        if (limiters.passwordReset) {
          const limiter = limiters.passwordReset;
          const wait = Math.max(0, ...(await Promise.all(keys.map((k) => limiter.consume(k)))));
          if (wait > 0) throw new TooManyRequestsError("Too many reset requests. Try again later.", wait);
        }

        const record = await repo().findCredentials(email);
        if (record) {
          const token = randomBytes(32).toString("base64url");
          await withTransaction(pool, async (client) => {
            const expiresAt = await new CustomersRepository(client).createPasswordReset(record.customer.id, hashToken(token), RESET_TTL_MINUTES);
            await events.publish(
              client,
              "customer.passwordResetRequested",
              { customer: record.customer, token, expiresAt },
              { sensitive: true }
            );
          });
          events.notify();
          logger.info("Password reset requested", { customerId: record.customer.id });
        }
        res.status(202).json({ status: "accepted" });
      })
    );

    router.post(
      "/customers/password-reset/confirm",
      withInput({ body: resetConfirmSchema, summary: "Set a new password with a reset code" }, async (_req, res, { body }) => {
        const customerId = await repo().consumePasswordReset(hashToken(body.token));
        if (!customerId) {
          throw new ValidationError("This reset code is invalid or has expired", [{ field: "token", message: "is invalid or expired" }], ErrorCodes.INVALID_RESET_TOKEN);
        }
        await repo().setPassword(customerId, await hashPassword(body.password));
        await sessions.revokeAll("customer", customerId);
        res.json({ status: "ok" });
      })
    );

    router.get(
      "/customers",
      authenticate,
      canRead,
      withInput({ query: { ...customerListQuery, ...PAGINATION_QUERY }, summary: "List customers" }, async (_req, res, { query }) => {
        sendPage(res, await repo().search({ q: query.q, limit: query.limit ?? 50, offset: query.offset ?? 0 }));
      })
    );

    router.get(
      "/customers/:id",
      authenticate,
      canRead,
      withInput({ params: ID_PARAMS, summary: "Get a customer" }, async (_req, res, { params }) => {
        res.json(found(await repo().findById(params.id), "Customer"));
      })
    );
  },
};
