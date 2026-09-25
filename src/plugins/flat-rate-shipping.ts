import type { CommercePlugin } from "../modules/types";

export interface FlatRateShippingOptions {
  /** Cost per order in the smallest currency unit (e.g. 10000 = 10 LYD). */
  rate: number;
  /** Orders whose items total at least this much ship free. */
  freeOver?: number;
  id?: string;
  name?: string;
}

/**
 * The simplest local delivery pricing: one fixed price per order, optionally
 * free above a threshold. Install it more than once with different ids for
 * several options (e.g. "standard" and "express").
 */
export function flatRateShipping(options: FlatRateShippingOptions): CommercePlugin {
  if (!Number.isInteger(options.rate) || options.rate < 0) {
    throw new Error("flatRateShipping: rate must be a non-negative integer (smallest currency unit)");
  }
  const id = options.id ?? "flat-rate";
  return {
    name: `flat-rate-shipping:${id}`,
    setup({ extensions }) {
      extensions.addShippingProvider({
        id,
        name: options.name ?? "Standard delivery",
        quote: ({ subtotal }) =>
          options.freeOver !== undefined && subtotal >= options.freeOver ? 0 : options.rate,
      });
    },
  };
}
