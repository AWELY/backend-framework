import type { AppRequest } from "../../engine/http/request";
import type { AccessControl } from "../../engine/access-control";
import { ConflictError, ForbiddenError, NotFoundError } from "../../engine/errors";
import type { CartHeader } from "./cart.schema";

/**
 * من يحق له استخدام السلة؟
 *
 *  - سلة الضيف (لا زبون مربوط بها): من يعرف رقمها. الرقم UUID عشوائي، فمعرفته تشبه
 *    معرفة رابط خاص لا يمكن تخمينه. الموقع يحفظ الرقم في متصفح المشتري.
 *  - سلة الزبون: ذلك الزبون فقط، أو مالك المتجر.
 *
 * أي شخص آخر يحصل على 404 وليس 403. لماذا؟ 403 تعني "موجودة لكنها ليست لك"، وهذا
 * بحد ذاته معلومة. أما 404 فلا تكشف حتى أن السلة موجودة.
 *
 * تستخدمها وحدتا السلة والطلبات (إتمام الشراء يطبق نفس القاعدة).
 * ترجع السلة نفسها إن نجح الفحص، فيمكن تمرير النتيجة مباشرة إلى assertCartOpen.
 */
export function assertCartAccess(req: AppRequest, cart: CartHeader | null, accessControl: AccessControl): CartHeader {
  if (!cart) throw new NotFoundError("Cart not found");
  // مرسل معروف بدور لا يملك cart:manage: نعرفه ونرفضه صراحة (403).
  if (req.auth && !accessControl.can(req.auth.role, "cart:manage")) {
    throw new ForbiddenError("Missing permission: cart:manage");
  }
  if (cart.customerId !== null) {
    const isOwnCart = req.auth?.userId === cart.customerId;
    const isStoreOwner = req.auth?.role === "owner";
    if (!isOwnCart && !isStoreOwner) throw new NotFoundError("Cart not found");
  }
  return cart;
}

/**
 * السلة يجب أن تكون مفتوحة. السلة التي اشتُريت (checked_out) لا تُعدَّل، وإلا لتغيّر
 * محتواها بعد أن أصبح طلباً. الرد 409: تعارض مع حالتها الحالية.
 */
export function assertCartOpen(cart: CartHeader): void {
  if (cart.status !== "open") throw new ConflictError("This cart has already been checked out");
}
