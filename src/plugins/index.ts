/**
 * الإضافات الجاهزة. كلها مبنية على نقاط التوسعة العامة فقط (docs/EXTENDING.md)، وتصلح نموذجاً
 * لكتابة إضافة جديدة.
 */
export { cashOnDelivery } from "./cash-on-delivery";
export { flatRateShipping, type FlatRateShippingOptions } from "./flat-rate-shipping";
export { cityRateShipping, type CityRateShippingOptions } from "./city-rate-shipping";
export { coupons, type Coupon } from "./coupons";
export { percentageTax, type PercentageTaxOptions } from "./percentage-tax";
