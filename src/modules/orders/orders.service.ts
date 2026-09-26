import type { Pool, QueryResultRow } from "pg";
import type { AppRequest } from "../../engine/http/request";
import type { AccessControl } from "../../engine/access-control";
import type { Logger } from "../../engine/logger";
import { ConflictError, NotFoundError, ValidationError } from "../../engine/errors";
import { withTransaction } from "../../db/transaction";
import { translateDbError } from "../../db/errors";
import type { Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import { InventoryRepository } from "../inventory/inventory.repository";
import { assertCartAccess, assertCartOpen } from "../cart/cart.access";
import type { CartHeader } from "../cart/cart.schema";
import type { ExtensionRegistry, PaymentProvider, PaymentResult, ShippingProvider } from "../extensions";
import { OrdersRepository } from "./orders.repository";
import {
  STATUS_TRANSITIONS,
  type CheckoutInput,
  type QuoteInput,
  type Order,
  type OrderItem,
  type OrderStatus,
  type PaymentStatus,
} from "./orders.schema";

interface LineRow {
  product_id: string;
  quantity: number;
  name: string;
  price: number;
  is_active: boolean;
}

async function query<R extends QueryResultRow>(db: Queryable, text: string, values: unknown[]) {
  try {
    return await db.query<R>(text, values);
  } catch (err) {
    throw translateDbError(err);
  }
}

export interface CheckoutResult {
  order: Order;
  /** What the payment plugin said (instructions / redirect), or null if the store has none. */
  payment: PaymentResult | null;
}

export interface Quote {
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  total: number;
}

/**
 * Multi-step order operations, each in ONE transaction (all steps happen, or
 * none). Shipping is priced inside the checkout transaction; payment starts
 * only AFTER it commits - a slow or failing gateway must never hold database
 * locks or cancel a valid order. Events are emitted after commit too, so
 * listeners never see an order that was then rolled back.
 */
export class OrdersService {
  constructor(
    private readonly pool: Pool,
    private readonly accessControl: AccessControl,
    private readonly extensions: ExtensionRegistry,
    private readonly logger: Logger
  ) {}

  private resolveShipping(method: string | undefined): ShippingProvider | null {
    const available = this.extensions.shippingProviders().map((p) => p.id);
    if (available.length === 0) {
      if (method) throw new ValidationError("This store has no shipping methods", [{ field: "shippingMethod", message: "is not an allowed field" }]);
      return null;
    }
    const provider = method ? this.extensions.shippingProvider(method) : undefined;
    if (!provider) {
      throw new ValidationError("Validation failed", [
        { field: "shippingMethod", message: `must be one of: ${available.join(", ")}` },
      ]);
    }
    return provider;
  }

  private resolvePayment(method: string | undefined): PaymentProvider | null {
    const available = this.extensions.paymentProviders().map((p) => p.id);
    if (available.length === 0) {
      if (method) throw new ValidationError("This store has no payment methods", [{ field: "paymentMethod", message: "is not an allowed field" }]);
      return null;
    }
    const provider = method ? this.extensions.paymentProvider(method) : undefined;
    if (!provider) {
      throw new ValidationError("Validation failed", [
        { field: "paymentMethod", message: `must be one of: ${available.join(", ")}` },
      ]);
    }
    return provider;
  }

  private async shippingCost(
    provider: ShippingProvider | null,
    lines: LineRow[],
    destination: { shippingAddress: string; shippingCity?: string }
  ): Promise<number> {
    if (!provider) return 0;
    const items = lines.map((l) => ({ productId: l.product_id, quantity: l.quantity, unitPrice: l.price }));
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    // Pass ONLY what pricing needs - not the buyer's name, phone or payment choice.
    const cost = await provider.quote({
      items,
      subtotal,
      shippingAddress: destination.shippingAddress,
      shippingCity: destination.shippingCity,
    });
    if (!Number.isInteger(cost) || cost < 0) {
      throw new Error(`Shipping provider '${provider.id}' returned an invalid cost: ${cost}`);
    }
    return cost;
  }

  private loadLines(db: Queryable, cartId: string) {
    return query<LineRow>(
      db,
      `SELECT ci.product_id, ci.quantity, p.name, p.price, p.is_active
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [cartId]
    );
  }

  /** Price a cart with a shipping method before checking out (no side effects). */
  async quote(req: AppRequest, input: QuoteInput): Promise<Quote> {
    const header = await query<{ id: string; customer_id: string | null; status: CartHeader["status"] }>(
      this.pool,
      "SELECT id, customer_id, status FROM carts WHERE id = $1",
      [input.cartId]
    );
    const row = header.rows[0];
    const cart = assertCartAccess(req, row ? { id: row.id, customerId: row.customer_id, status: row.status } : null, this.accessControl);
    const lines = (await this.loadLines(this.pool, cart.id)).rows.filter((l) => l.is_active);
    const provider = this.resolveShipping(input.shippingMethod);
    const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
    const shippingCost = await this.shippingCost(provider, lines, input);
    return { subtotal, shippingMethod: provider?.id ?? null, shippingCost, total: subtotal + shippingCost };
  }

  /**
   * Cart -> order. Locks the cart row first (SELECT ... FOR UPDATE), so two
   * simultaneous checkouts of one cart run one after the other and the second
   * gets 409. Stock is decremented atomically per line; if ANY line is short
   * the whole transaction rolls back and nothing is sold.
   */
  async checkout(req: AppRequest, input: CheckoutInput): Promise<CheckoutResult> {
    const shipping = this.resolveShipping(input.shippingMethod);
    const paymentProvider = this.resolvePayment(input.paymentMethod);

    const orderId = await withTransaction(this.pool, async (client) => {
      const locked = await query<{ id: string; customer_id: string | null; status: CartHeader["status"] }>(
        client,
        "SELECT id, customer_id, status FROM carts WHERE id = $1 FOR UPDATE",
        [input.cartId]
      );
      const row = locked.rows[0];
      const cart = assertCartAccess(
        req,
        row ? { id: row.id, customerId: row.customer_id, status: row.status } : null,
        this.accessControl
      );
      assertCartOpen(cart);

      const lines = (await this.loadLines(client, cart.id)).rows;
      if (lines.length === 0) throw new ValidationError("The cart is empty");
      const unavailable = lines.filter((l) => !l.is_active).map((l) => l.product_id);
      if (unavailable.length > 0) {
        throw new ConflictError("Some products in the cart are no longer available", { productIds: unavailable });
      }

      const inventory = new InventoryRepository(client);
      for (const line of lines) {
        await inventory.adjust(line.product_id, -line.quantity);
      }

      const items: OrderItem[] = lines.map((l) => ({
        productId: l.product_id,
        productName: l.name,
        unitPrice: l.price,
        quantity: l.quantity,
        lineTotal: l.price * l.quantity,
      }));
      const customerId = cart.customerId ?? (req.auth?.role === "customer" ? (req.auth.userId ?? null) : null);

      const id = await new OrdersRepository(client).insert({
        customerId,
        cartId: cart.id,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        shippingAddress: input.shippingAddress,
        shippingCity: input.shippingCity ?? null,
        subtotal: items.reduce((sum, i) => sum + i.lineTotal, 0),
        shippingMethod: shipping?.id ?? null,
        shippingCost: await this.shippingCost(shipping, lines, input),
        paymentMethod: paymentProvider?.id ?? null,
        items,
      });
      await query(client, "UPDATE carts SET status = 'checked_out', updated_at = now() WHERE id = $1", [cart.id]);
      return id;
    });

    const orders = new OrdersRepository(this.pool);
    let payment: PaymentResult | null = null;
    if (paymentProvider) {
      try {
        payment = await paymentProvider.initiate((await orders.findById(orderId)) as Order);
      } catch (err) {
        this.logger.error(`Payment provider '${paymentProvider.id}' failed to start payment`, {
          orderId,
          message: err instanceof Error ? err.message : String(err),
        });
        payment = { status: "failed" };
      }
      await orders.setPayment(orderId, payment.status, payment.reference);
    }

    const order = (await orders.findById(orderId)) as Order;
    await this.extensions.emit("order.created", { order });
    return { order, payment };
  }

  /** Owner changes an order's status; cancelling puts the items back in stock. */
  async changeStatus(orderId: string, next: OrderStatus): Promise<Order> {
    const { order, from } = await withTransaction(this.pool, async (client) => {
      const orders = new OrdersRepository(client);
      const current = await orders.findById(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Order not found");
      if (!STATUS_TRANSITIONS[current.status].includes(next)) {
        throw new ConflictError(`Cannot change an order from '${current.status}' to '${next}'`, {
          allowed: STATUS_TRANSITIONS[current.status],
        });
      }
      if (next === "cancelled") {
        const inventory = new InventoryRepository(client);
        for (const item of current.items) {
          // A product deleted since the order has product_id NULL - nothing to restock.
          if (item.productId) await inventory.adjust(item.productId, item.quantity);
        }
      }
      await orders.setStatus(current.id, next);
      return { order: (await orders.findById(current.id)) as Order, from: current.status };
    });
    await this.extensions.emit("order.statusChanged", { order, from });
    return order;
  }

  /** Records a payment outcome - called by the owner, or by a payment plugin's webhook. */
  async setPaymentStatus(orderId: string, status: PaymentStatus, reference?: string): Promise<Order> {
    const { order, from } = await withTransaction(this.pool, async (client) => {
      const orders = new OrdersRepository(client);
      const current = await orders.findById(orderId, { forUpdate: true });
      if (!current) throw new NotFoundError("Order not found");
      await orders.setPayment(current.id, status, reference);
      return { order: (await orders.findById(current.id)) as Order, from: current.paymentStatus };
    });
    await this.extensions.emit("order.paymentChanged", { order, from });
    return order;
  }
}

export const ORDERS_SERVICE = createToken<OrdersService>("OrdersService");
