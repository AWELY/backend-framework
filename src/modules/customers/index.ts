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
 * Customer accounts - OPTIONAL: guests can still check out without one.
 *
 *   POST  /customers/register   public            -> 201 { customer, token }
 *   POST  /customers/login      public            -> { customer, token }
 *   GET   /customers/me         logged-in customer
 *   PATCH /customers/me         profile:manage    body { name?, phone? }
 *   GET   /customers            customers:read    (owner)
 *   GET   /customers/:id        customers:read    (owner)
 *
 * The token goes in later requests as "Authorization: Bearer <token>".
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

    /** The logged-in customer's own id; the owner has no customer profile. */
    const selfId = (req: AppRequest): string => {
      if (req.auth?.role !== "customer" || !req.auth.userId) {
        throw new ForbiddenError("Only a logged-in customer has a profile");
      }
      return req.auth.userId;
    };

    /**
     * Rate limited per IP: every attempt that reaches password hashing counts
     * (a duplicate email costs a hash too). Invalid bodies are rejected by
     * validateBody before this runs, so typos are not counted. Check and count
     * happen synchronously, before any await, so a burst of parallel requests
     * cannot all slip under the limit at once.
     */
    router.post("/customers/register", validateBody(registerSchema), async (req, res) => {
      if (registrationLimiter) {
        const key = `ip:${clientIp(req)}`;
        const wait = registrationLimiter.retryAfter(key);
        if (wait > 0) throw new TooManyRequestsError("Too many accounts created from this address. Try again later.", wait);
        registrationLimiter.recordAttempt(key);
      }
      const input = req.body as RegisterInput;
      const customer = await repo().create({
        email: normalizeEmail(input.email),
        passwordHash: await hashPassword(input.password),
        name: input.name,
        phone: input.phone,
      });
      res.status(201).json({ customer, token: issueCustomerToken(customer.id) });
    });

    /**
     * Rate limited per IP AND per email (failures only). The check runs BEFORE
     * any password hashing, so a blocked caller costs the server almost nothing.
     * A success clears the email's counter but not the IP's, so an attacker
     * cannot reset their IP counter by logging into their own account in between.
     */
    router.post("/customers/login", validateBody(loginSchema), async (req, res) => {
      const { email, password } = req.body as LoginInput;
      const normalized = normalizeEmail(email);
      const keys = [`ip:${clientIp(req)}`, `email:${normalized}`];

      if (loginLimiter) {
        const wait = Math.max(...keys.map((key) => loginLimiter.retryAfter(key)));
        if (wait > 0) throw new TooManyRequestsError("Too many failed login attempts. Try again later.", wait);
      }

      const record = await repo().findCredentials(normalized);
      const ok = record ? await verifyPassword(password, record.passwordHash) : await verifyAgainstDummy(password);
      // Same message for "no such email" and "wrong password": the response
      // must not tell an attacker which emails are registered.
      if (!record || !ok) {
        for (const key of keys) loginLimiter?.recordFailure(key);
        throw new UnauthorizedError("Invalid email or password");
      }
      loginLimiter?.reset(`email:${normalized}`);
      res.json({ customer: record.customer, token: issueCustomerToken(record.customer.id) });
    });

    router.get("/customers/me", authenticate, async (req, res) => {
      res.json(found(await repo().findById(selfId(req)), "Customer"));
    });

    router.patch(
      "/customers/me",
      authenticate,
      requirePermission(accessControl, "profile:manage"),
      validateBody(profileSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().updateProfile(selfId(req), req.body as Partial<ProfileInput>), "Customer"));
      }
    );

    router.get("/customers", authenticate, canRead, async (req, res) => {
      res.json(await repo().findAll(parsePagination(req.query)));
    });

    router.get("/customers/:id", authenticate, canRead, async (req, res) => {
      res.json(found(await repo().findById(req.params.id as string), "Customer"));
    });
  },
};
