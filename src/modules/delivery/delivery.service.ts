import type { Pool, PoolClient } from "pg";
import type { AccessControl } from "../../engine/access-control";
import type { AppRequest } from "../../engine/http/request";
import { ConflictError, ErrorCodes, ForbiddenError, NotFoundError, ValidationError } from "../../engine/errors";
import { withTransaction } from "../../db/transaction";
import { createToken } from "../../container/tokens";
import type { EventPublisher } from "../types";
import { actorOf, type Actor } from "../shared";
import { OrdersRepository } from "../orders/orders.repository";
import type { OrdersService } from "../orders/orders.service";
import { OrderTimeline } from "../orders/orders.timeline";
import type { Order } from "../orders/orders.schema";
import { StaffRepository } from "../staff/staff.repository";
import { DeliveryRepository } from "./delivery.repository";
import type { Delivery, DeliveryStatus } from "./delivery.schema";

/**
 * منطق التوصيل. كل خطوة معاملة واحدة تغيّر معاً: صف التوصيل، وحالة الطلب (عبر OrdersService
 * داخل نفس المعاملة)، وحالة الدفع عند التحصيل، وسجل الطلب الزمني، والحدث order.deliveryChanged.
 *
 * من يحق له ماذا:
 *   - الإسناد: orders:assign (المدير والمشرف).
 *   - الاستلام والتسليم والمحاولة الفاشلة: المندوب المسند إليه (deliveries:update-own)،
 *     أو من يملك deliveries:update-all (المدير، لتصحيح خطأ مندوب).
 */
export class DeliveryService {
  constructor(
    private readonly pool: Pool,
    private readonly accessControl: AccessControl,
    private readonly orders: () => OrdersService,
    private readonly events: EventPublisher
  ) {}

  /** يتحقق أن المرسل يستطيع تحريك هذا التوصيل. */
  private assertCanUpdate(req: AppRequest, delivery: Delivery): void {
    const role = req.auth?.role;
    if (this.accessControl.can(role, "deliveries:update-all")) return;
    if (this.accessControl.can(role, "deliveries:update-own") && req.auth?.userId === delivery.courierId) return;
    // مندوب يحاول تحريك توصيل غيره: 404، لا نكشف حتى أنه موجود.
    if (this.accessControl.can(role, "deliveries:update-own")) throw new NotFoundError("Delivery not found");
    throw new ForbiddenError("Missing permission: deliveries:update-own");
  }

  /** يكتب سطر السجل الزمني والحدث بعد أي تغيير، داخل المعاملة نفسها. */
  private async finish(client: PoolClient, orderId: string, status: DeliveryStatus, actor: Actor, note?: string | null): Promise<Delivery> {
    const delivery = (await new DeliveryRepository(client).get(orderId)) as Delivery;
    await new OrderTimeline(client).record(orderId, { type: "delivery", to: status, actor, note: note ?? null }, client);
    const order = (await new OrdersRepository(client).findById(orderId)) as Order;
    await this.events.publish(client, "order.deliveryChanged", { order, delivery });
    return delivery;
  }

  /**
   * يسند طلباً لمندوب (أو يعيد إسناده بعد محاولة فاشلة). الطلب المعلّق يُؤكَّد تلقائياً.
   * المندوب يجب أن يكون حساب موظف نشطاً بدور يسمح بالتوصيل.
   */
  async assign(req: AppRequest, orderId: string, courierId: string, note?: string): Promise<Delivery> {
    const actor = actorOf(req);
    const delivery = await withTransaction(this.pool, async (client) => {
      const order = await new OrdersRepository(client).findById(orderId, { forUpdate: true });
      if (!order) throw new NotFoundError("Order not found");
      if (!["pending", "confirmed", "shipped"].includes(order.status)) {
        throw new ConflictError(`An order that is '${order.status}' cannot be assigned for delivery`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      const role = await new StaffRepository(client).activeRole(courierId);
      if (!role || !this.accessControl.can(role, "deliveries:update-own")) {
        throw new ValidationError("Validation failed", [{ field: "courierId", message: "must be an active courier" }]);
      }
      const repo = new DeliveryRepository(client);
      const current = await repo.get(orderId, { forUpdate: true });
      if (current && (current.status === "picked_up" || current.status === "delivered")) {
        throw new ConflictError(`The delivery is already '${current.status}'`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      if (order.status === "pending") await this.orders().applyStatus(client, orderId, "confirmed", actor, { note: "Confirmed on assignment" });
      await repo.assign(orderId, courierId, note ?? null);
      return this.finish(client, orderId, "assigned", actor, note);
    });
    this.events.notify();
    return delivery;
  }

  /** المندوب استلم الطلب من المحل: التوصيل picked_up، والطلب shipped. */
  async pickup(req: AppRequest, orderId: string, note?: string): Promise<Delivery> {
    const actor = actorOf(req);
    const delivery = await withTransaction(this.pool, async (client) => {
      const repo = new DeliveryRepository(client);
      const current = await repo.get(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Delivery not found");
      this.assertCanUpdate(req, current);
      if (current.status !== "assigned" && current.status !== "failed") {
        throw new ConflictError(`Cannot pick up a delivery that is '${current.status}'`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      const order = (await new OrdersRepository(client).findById(orderId, { forUpdate: true })) as Order;
      if (order.status === "confirmed") await this.orders().applyStatus(client, orderId, "shipped", actor);
      else if (order.status !== "shipped") {
        throw new ConflictError(`An order that is '${order.status}' cannot be picked up`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      await repo.setStatus(orderId, "picked_up", { note: note ?? null });
      return this.finish(client, orderId, "picked_up", actor, note);
    });
    this.events.notify();
    return delivery;
  }

  /**
   * المندوب سلّم الطلب: التوصيل delivered، والطلب delivered. إن لم يكن الطلب مدفوعاً (الدفع عند
   * الاستلام)، يجب أن يسجّل المندوب النقود التي استلمها، وأن تساوي إجمالي الطلب بالضبط، فيصبح
   * الطلب مدفوعاً. إن كان مدفوعاً مسبقاً (دفع إلكتروني)، لا يُقبل تحصيل نقود.
   */
  async deliver(req: AppRequest, orderId: string, input: { cashCollected?: number; note?: string }): Promise<Delivery> {
    const actor = actorOf(req);
    const delivery = await withTransaction(this.pool, async (client) => {
      const repo = new DeliveryRepository(client);
      const current = await repo.get(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Delivery not found");
      this.assertCanUpdate(req, current);
      if (current.status !== "picked_up") {
        throw new ConflictError(`Cannot deliver a delivery that is '${current.status}'`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      const order = (await new OrdersRepository(client).findById(orderId, { forUpdate: true })) as Order;
      const paid = order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded" || order.paymentStatus === "refunded";
      if (paid && (input.cashCollected ?? 0) > 0) {
        throw new ValidationError("Validation failed", [{ field: "cashCollected", message: "must be 0: the order is already paid" }]);
      }
      if (!paid && input.cashCollected !== order.total) {
        throw new ValidationError("Validation failed", [{ field: "cashCollected", message: `must equal the order total (${order.total})` }]);
      }
      await this.orders().applyStatus(client, orderId, "delivered", actor);
      if (!paid) await this.orders().applyPayment(client, orderId, "paid", undefined, actor);
      await repo.setStatus(orderId, "delivered", { note: input.note ?? null, cashCollected: input.cashCollected ?? 0 });
      return this.finish(client, orderId, "delivered", actor, input.note);
    });
    this.events.notify();
    return delivery;
  }

  /** محاولة توصيل لم تنجح، مع سبب. الطلب يبقى كما هو، ويمكن إسناده من جديد أو استلامه مرة أخرى. */
  async fail(req: AppRequest, orderId: string, note: string): Promise<Delivery> {
    const actor = actorOf(req);
    const delivery = await withTransaction(this.pool, async (client) => {
      const repo = new DeliveryRepository(client);
      const current = await repo.get(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Delivery not found");
      this.assertCanUpdate(req, current);
      if (current.status !== "assigned" && current.status !== "picked_up") {
        throw new ConflictError(`Cannot fail a delivery that is '${current.status}'`, undefined, ErrorCodes.INVALID_STATUS_TRANSITION);
      }
      await repo.setStatus(orderId, "failed", { note });
      return this.finish(client, orderId, "failed", actor, note);
    });
    this.events.notify();
    return delivery;
  }
}

export const DELIVERY_SERVICE = createToken<DeliveryService>("DeliveryService");
