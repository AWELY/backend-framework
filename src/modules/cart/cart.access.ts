import type { AppRequest } from "../../engine/http/request";
import type { AccessControl } from "../../engine/access-control";
import { ConflictError, ForbiddenError, NotFoundError } from "../../engine/errors";
import type { CartHeader } from "./cart.schema";

/**
 * Who may use a cart:
 *  - a GUEST cart (no customer): whoever holds its id. The id is a random UUID,
 *    so knowing it works like knowing a private link.
 *  - a CUSTOMER's cart: only that customer, or the owner.
 * Anyone else gets 404, not 403, so they cannot even learn the cart exists.
 * Shared by the Cart and Orders modules (checkout applies the same rule).
 */
export function assertCartAccess(req: AppRequest, cart: CartHeader | null, accessControl: AccessControl): CartHeader {
  if (!cart) throw new NotFoundError("Cart not found");
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

export function assertCartOpen(cart: CartHeader): void {
  if (cart.status !== "open") throw new ConflictError("This cart has already been checked out");
}
