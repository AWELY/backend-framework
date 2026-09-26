// What the browser remembers between pages: the cart id and the login session.
// localStorage can be unavailable (private mode, blocked storage) - every access
// is guarded so the site still works, just without remembering.

const KEYS = { cart: "ama.cartId", token: "ama.token", customer: "ama.customer" };

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable - nothing to do
  }
}

export const getCartId = () => read(KEYS.cart);
export const setCartId = (id) => write(KEYS.cart, id);

export const getToken = () => read(KEYS.token);

export function getCustomer() {
  try {
    return JSON.parse(read(KEYS.customer) ?? "null");
  } catch {
    return null;
  }
}

export function saveSession(token, customer) {
  write(KEYS.token, token);
  write(KEYS.customer, JSON.stringify({ name: customer.name, email: customer.email }));
}

export function clearSession() {
  write(KEYS.token, null);
  write(KEYS.customer, null);
}
