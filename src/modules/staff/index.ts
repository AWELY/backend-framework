import type { CommerceModule } from "../types";
import type { AppRequest } from "../../engine/http/request";
import { withInput } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { ErrorCodes, ForbiddenError, TooManyRequestsError, UnauthorizedError, ValidationError } from "../../engine/errors";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../engine/password";
import { found, sendPage, PAGINATION_QUERY, ID_PARAMS } from "../shared";
import { normalizeEmail, passwordChangeSchema } from "../customers/customers.schema";
import { staffMigrations, staffLoginSchema, createStaffSchema, updateStaffSchema, staffListQuery } from "./staff.schema";
import { StaffRepository, STAFF_REPOSITORY } from "./staff.repository";

/**
 * وحدة الموظفين.
 *
 * المسارات:
 *   POST  /staff/login          { email, password } يرجع { staff, token }. نفس حد محاولات الدخول
 *   POST  /staff/logout         يُلغي جلسة هذا الجهاز (204)
 *   GET   /staff/me             حساب الموظف الداخل
 *   POST  /staff/me/password    تغيير كلمة المرور (يُخرج الأجهزة الأخرى)
 *   GET   /staff/roles          الأدوار المتاحة لحسابات الموظفين (staff:read)
 *   GET   /staff                staff:read. ?role=courier &q= &limit= &offset=
 *   POST  /staff                staff:write (المالك): حساب جديد بدور
 *   GET   /staff/:id            staff:read
 *   PATCH /staff/:id            staff:write: الاسم، والهاتف، والدور، والإيقاف، وكلمة المرور
 *
 * كل محاولة دخول (ناجحة أو فاشلة) تُكتب في سجل التدقيق، لأنها لا تمر بمسار كتابة مصادَق.
 */
export const staffModule: CommerceModule = {
  name: "staff",
  migrations: staffMigrations,

  register({ router, container, pool, accessControl, authenticate, sessions, limiters, clientIp, audit, logger }) {
    container.register(STAFF_REPOSITORY, () => new StaffRepository(pool));
    const repo = () => container.resolve(STAFF_REPOSITORY);
    const canRead = requirePermission(accessControl, "staff:read");
    const canWrite = requirePermission(accessControl, "staff:write");

    // الجلسة تقرأ دور الموظف الحالي مع كل طلب: تغيير الدور أو الإيقاف يسري فوراً.
    sessions.registerPrincipal("staff", (id, db) => new StaffRepository(db).activeRole(id));

    const selfId = (req: AppRequest): string => {
      if (req.auth?.principal !== "staff" || !req.auth.userId) throw new ForbiddenError("Only a logged-in staff member has a staff profile");
      return req.auth.userId;
    };

    /** الدور يجب أن يكون دور موظف معرّفاً في جدول الصلاحيات (لا owner ولا customer). */
    const assertStaffRole = (role: string | undefined) => {
      if (role === undefined) return;
      const roles = accessControl.staffRoles();
      if (!roles.includes(role)) throw new ValidationError("Validation failed", [{ field: "role", message: `must be one of: ${roles.join(", ")}` }]);
    };

    const recordLogin = (req: AppRequest, email: string, ok: boolean, staffId?: string, role?: string) =>
      audit
        .record({
          actorType: "staff",
          actorId: staffId ?? null,
          actorRole: role ?? "unknown",
          action: ok ? "staff.login" : "staff.login_failed",
          route: req.route ?? null,
          path: "/staff/login",
          statusCode: ok ? 200 : 401,
          requestId: req.id,
          ip: clientIp(req),
          body: { email },
        })
        .catch((err: unknown) => logger.error("Failed to audit a staff login", { message: err instanceof Error ? err.message : String(err) }));

    router.post(
      "/staff/login",
      withInput({ body: staffLoginSchema, summary: "Log in as a staff member" }, async (req, res, { body }) => {
        const email = normalizeEmail(body.email);
        const keys = [`staff-ip:${clientIp(req)}`, `staff-email:${email}`];
        if (limiters.login) {
          const wait = Math.max(0, ...(await Promise.all(keys.map((k) => limiters.login?.retryAfter(k) ?? 0))));
          if (wait > 0) throw new TooManyRequestsError("Too many failed login attempts. Try again later.", wait);
        }
        const record = await repo().findCredentials(email);
        const ok = record ? await verifyPassword(body.password, record.passwordHash) : await verifyAgainstDummy(body.password);
        if (!record || !ok || !record.staff.isActive) {
          for (const key of keys) await limiters.login?.recordFailure(key);
          await recordLogin(req, email, false, record?.staff.id, record?.staff.role);
          throw new UnauthorizedError("Invalid email or password", ErrorCodes.INVALID_CREDENTIALS);
        }
        await limiters.login?.reset(`staff-email:${email}`);
        const { token } = await sessions.issue(
          { type: "staff", id: record.staff.id, role: record.staff.role },
          { ip: clientIp(req), userAgent: req.headers["user-agent"] }
        );
        await recordLogin(req, email, true, record.staff.id, record.staff.role);
        res.json({ staff: record.staff, token });
      })
    );

    router.post(
      "/staff/logout",
      authenticate,
      withInput({ summary: "Log out of this device", successStatus: 204 }, async (req, res) => {
        selfId(req);
        if (req.auth?.sessionId) await sessions.revoke(req.auth.sessionId);
        res.status(204).end();
      })
    );

    router.get(
      "/staff/me",
      authenticate,
      withInput({ summary: "The logged-in staff member" }, async (req, res) => {
        res.json(found(await repo().findById(selfId(req)), "Staff member"));
      })
    );

    router.post(
      "/staff/me/password",
      authenticate,
      withInput({ body: passwordChangeSchema, summary: "Change your password", successStatus: 204 }, async (req, res, { body }) => {
        const id = selfId(req);
        const stored = await repo().passwordHashOf(id);
        if (!stored || !(await verifyPassword(body.currentPassword, stored))) {
          throw new ValidationError("Validation failed", [{ field: "currentPassword", message: "is incorrect" }], ErrorCodes.INVALID_CREDENTIALS);
        }
        await repo().update(id, { passwordHash: await hashPassword(body.newPassword) });
        await sessions.revokeAll("staff", id, { exceptSessionId: req.auth?.sessionId });
        res.status(204).end();
      })
    );

    router.get(
      "/staff/roles",
      authenticate,
      canRead,
      withInput({ summary: "Roles a staff account can have" }, (_req, res) => {
        res.json(accessControl.staffRoles());
      })
    );

    router.get(
      "/staff",
      authenticate,
      canRead,
      withInput({ query: { ...staffListQuery, ...PAGINATION_QUERY }, summary: "List staff accounts" }, async (_req, res, { query }) => {
        sendPage(res, await repo().search({ role: query.role, q: query.q, limit: query.limit ?? 50, offset: query.offset ?? 0 }));
      })
    );

    router.post(
      "/staff",
      authenticate,
      canWrite,
      withInput({ body: createStaffSchema, summary: "Create a staff account", successStatus: 201 }, async (_req, res, { body }) => {
        assertStaffRole(body.role);
        const staff = await repo().create({
          email: normalizeEmail(body.email),
          passwordHash: await hashPassword(body.password),
          name: body.name,
          phone: body.phone,
          role: body.role,
        });
        res.status(201).json(staff);
      })
    );

    router.get(
      "/staff/:id",
      authenticate,
      canRead,
      withInput({ params: ID_PARAMS, summary: "Get a staff account" }, async (_req, res, { params }) => {
        res.json(found(await repo().findById(params.id), "Staff member"));
      })
    );

    router.patch(
      "/staff/:id",
      authenticate,
      canWrite,
      withInput({ params: ID_PARAMS, body: updateStaffSchema, partial: true, summary: "Update a staff account" }, async (_req, res, { params, body }) => {
        assertStaffRole(body.role);
        const { password, ...rest } = body;
        const staff = found(
          await repo().update(params.id, { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) }),
          "Staff member"
        );
        // إيقاف، أو دور جديد، أو كلمة مرور جديدة: كل جلساته الحالية تنتهي الآن.
        if (body.isActive === false || body.role !== undefined || password !== undefined) {
          await sessions.revokeAll("staff", staff.id);
        }
        res.json(staff);
      })
    );
  },
};
