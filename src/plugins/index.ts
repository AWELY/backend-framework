/**
 * الإضافات المدمجة مع الإطار، كأمثلة جاهزة.
 *
 * تستخدم فقط نقاط التوسع العامة (ModuleContext.extensions)، تماماً كما تفعل إضافة يكتبها
 * أي مطور من خارج الفريق. لذلك هي المرجع لكتابة إضافة جديدة، مثل ربط بوابة دفع ليبية حقيقية.
 *
 *   cashOnDelivery    : الدفع عند الاستلام.
 *   flatRateShipping  : شحن بسعر ثابت لكل طلب.
 *   cityRateShipping  : شحن بسعر حسب المدينة.
 */
export { cashOnDelivery } from "./cash-on-delivery";
export { flatRateShipping, type FlatRateShippingOptions } from "./flat-rate-shipping";
export { cityRateShipping, type CityRateShippingOptions } from "./city-rate-shipping";
