/**
 * Built-in example plugins. They use only the public extension points
 * (ModuleContext.extensions), exactly like a third-party plugin would - they
 * are the reference for writing one (e.g. a real local payment gateway).
 */
export { cashOnDelivery } from "./cash-on-delivery";
export { flatRateShipping, type FlatRateShippingOptions } from "./flat-rate-shipping";
