import type { Logger } from "../engine/logger";
import type { Order, OrderStatus, PaymentStatus } from "./orders/orders.schema";

/**
 * The framework's extension points. Plugins do not patch framework code; they
 * register providers and event listeners here, and the Orders module calls them:
 *
 *   - ShippingProvider : prices delivery for a cart + address at checkout
 *   - PaymentProvider  : starts payment right after an order is created
 *   - events           : order.created, order.statusChanged, order.paymentChanged
 */

export interface ShippingQuoteInput {
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  /** Items total, smallest currency unit. */
  subtotal: number;
  shippingAddress: string;
  /** Destination city as chosen by the buyer (from the provider's `cities` list, if it has one). */
  shippingCity?: string;
}

export interface ShippingProvider {
  id: string;
  name: string;
  /**
   * Cities this method delivers to. When present, the storefront shows them as
   * a drop-down and checkout requires one of them (see cityRateShipping).
   */
  cities?: string[];
  /** Shipping cost in the smallest currency unit. Runs inside the checkout transaction - keep it fast. */
  quote(input: ShippingQuoteInput): number | Promise<number>;
}

export interface PaymentResult {
  status: Exclude<PaymentStatus, "unpaid" | "refunded">;
  /** Shown to the buyer, e.g. "pay the courier in cash". */
  instructions?: string;
  /** For gateways that take the buyer to a hosted payment page. */
  redirectUrl?: string;
  /** The gateway's own transaction id. */
  reference?: string;
}

export interface PaymentProvider {
  id: string;
  name: string;
  /** Called AFTER the order is committed; a failure here never undoes the order. */
  initiate(order: Order): PaymentResult | Promise<PaymentResult>;
}

export interface CommerceEvents {
  "order.created": { order: Order };
  "order.statusChanged": { order: Order; from: OrderStatus };
  "order.paymentChanged": { order: Order; from: PaymentStatus };
}

type Listener<E extends keyof CommerceEvents> = (payload: CommerceEvents[E]) => void | Promise<void>;

export class ExtensionRegistry {
  private readonly shipping = new Map<string, ShippingProvider>();
  private readonly payment = new Map<string, PaymentProvider>();
  private readonly listeners = new Map<keyof CommerceEvents, Array<Listener<keyof CommerceEvents>>>();

  constructor(private readonly logger: Logger) {}

  addShippingProvider(provider: ShippingProvider): void {
    if (this.shipping.has(provider.id)) throw new Error(`Shipping provider '${provider.id}' is already registered`);
    this.shipping.set(provider.id, provider);
  }

  addPaymentProvider(provider: PaymentProvider): void {
    if (this.payment.has(provider.id)) throw new Error(`Payment provider '${provider.id}' is already registered`);
    this.payment.set(provider.id, provider);
  }

  shippingProvider(id: string): ShippingProvider | undefined {
    return this.shipping.get(id);
  }

  paymentProvider(id: string): PaymentProvider | undefined {
    return this.payment.get(id);
  }

  shippingProviders(): ShippingProvider[] {
    return [...this.shipping.values()];
  }

  paymentProviders(): PaymentProvider[] {
    return [...this.payment.values()];
  }

  on<E extends keyof CommerceEvents>(event: E, listener: Listener<E>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener<keyof CommerceEvents>);
    this.listeners.set(event, list);
  }

  /**
   * Runs every listener. A failing listener is logged and skipped: a broken
   * notification plugin must never turn a successful order into an error.
   */
  async emit<E extends keyof CommerceEvents>(event: E, payload: CommerceEvents[E]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        await listener(payload);
      } catch (err) {
        this.logger.error(`Listener for '${event}' failed`, { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
