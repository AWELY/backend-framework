import { API_BASE } from "./config.js";
import { getToken, clearSession, getCartId, setCartId } from "./store.js";

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Calls the store API. Sends the customer's login token when there is one. If
 * the token has expired (401), the session is cleared and the request is
 * retried once as a guest, so a stale login never breaks the public pages.
 */
export async function api(path, { method = "GET", body, retried = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", null);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    if (res.status === 401 && token && !retried && data?.error?.message === "Invalid or expired token") {
      clearSession();
      return api(path, { method, body, retried: true });
    }
    throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.details ?? null);
  }
  return data;
}

/**
 * The visitor's open cart, created on first need. A remembered cart that no
 * longer exists or was already checked out is replaced by a fresh one.
 */
export async function getOrCreateCart() {
  const id = getCartId();
  if (id) {
    try {
      const cart = await api(`/carts/${id}`);
      if (cart.status === "open") return cart;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }
  const cart = await api("/carts", { method: "POST" });
  setCartId(cart.id);
  return cart;
}

/** The remembered cart WITHOUT creating one (null if the visitor has none yet). */
export async function getExistingCart() {
  const id = getCartId();
  if (!id) return null;
  try {
    const cart = await api(`/carts/${id}`);
    return cart.status === "open" ? cart : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setCartId(null);
      return null;
    }
    throw err;
  }
}

export async function addToCart(productId, quantity) {
  const cart = await getOrCreateCart();
  return api(`/carts/${cart.id}/items`, { method: "POST", body: { productId, quantity } });
}
