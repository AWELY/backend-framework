import type { CommercePlugin } from "../modules/types";

/**
 * Cash on delivery - the most common way small Libyan stores get paid, and a
 * payment method that needs no external gateway. Payment stays "pending" until
 * the owner marks it paid (PATCH /orders/:id/payment) after the courier collects it.
 */
export function cashOnDelivery(options: { name?: string; instructions?: string } = {}): CommercePlugin {
  return {
    name: "cash-on-delivery",
    setup({ extensions }) {
      extensions.addPaymentProvider({
        id: "cod",
        name: options.name ?? "Cash on delivery",
        initiate: () => ({
          status: "pending",
          instructions: options.instructions ?? "Pay the courier in cash when your order arrives.",
        }),
      });
    },
  };
}
