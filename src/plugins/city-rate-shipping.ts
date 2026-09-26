import type { CommercePlugin } from "../modules/types";
import { ValidationError } from "../engine/errors";

export interface CityRateShippingOptions {
  /**
   * Delivery price per city, in the smallest currency unit, e.g.
   * { "طرابلس": 10000, "بنغازي": 20000 }. Cities not listed are not served.
   * The keys, in this order, are what the storefront shows in its drop-down.
   */
  rates: Record<string, number>;
  /** Orders whose items total at least this much ship free (in served cities). */
  freeOver?: number;
  id?: string;
  name?: string;
}

/**
 * Delivery priced by destination city - how most Libyan online stores charge.
 * It publishes its cities (GET /checkout/options), so the storefront builds the
 * city drop-down from the plugin instead of hard-coding it, and it rejects a
 * city it does not serve with a 400 that lists the valid ones.
 */
export function cityRateShipping(options: CityRateShippingOptions): CommercePlugin {
  const cities = Object.keys(options.rates);
  if (cities.length === 0) throw new Error("cityRateShipping: at least one city is required");
  for (const [city, rate] of Object.entries(options.rates)) {
    if (!Number.isInteger(rate) || rate < 0) {
      throw new Error(`cityRateShipping: rate for "${city}" must be a non-negative integer (smallest currency unit)`);
    }
  }
  const id = options.id ?? "city-rate";

  return {
    name: `city-rate-shipping:${id}`,
    setup({ extensions }) {
      extensions.addShippingProvider({
        id,
        name: options.name ?? "Home delivery",
        cities,
        quote: ({ subtotal, shippingCity }) => {
          const city = shippingCity?.trim();
          const rate = city === undefined ? undefined : options.rates[city];
          if (rate === undefined) {
            throw new ValidationError("Validation failed", [
              { field: "shippingCity", message: `must be one of: ${cities.join(", ")}` },
            ]);
          }
          return options.freeOver !== undefined && subtotal >= options.freeOver ? 0 : rate;
        },
      });
    },
  };
}
