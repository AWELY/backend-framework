require("dotenv").config({ quiet: true });

/**
 * A complete shopping journey against the RUNNING demo store (npm start first),
 * printed step by step - meant for live demonstrations. It uses only the public
 * HTTP API, exactly like a storefront (web or mobile) would.
 */

const BASE = `http://localhost:${process.env.PORT ?? 3000}`;
const OWNER = { "x-api-key": process.env.OWNER_API_KEY };
const lyd = (dirhams) => `${(dirhams / 1000).toFixed(3)} LYD`;
let step = 0;

async function call(method, path, { body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function show(title, res, summary) {
  step++;
  console.log(`\n${step}. ${title}  ->  HTTP ${res.status}`);
  if (summary) console.log(`   ${summary}`);
}

async function main() {
  const health = await call("GET", "/health");
  show("Health check (server + database)", health, JSON.stringify(health.body));

  const catalogue = await call("GET", "/products");
  show("Browse the catalogue as a visitor", catalogue, `${catalogue.body.length} products`);
  const coffee = catalogue.body.find((p) => p.slug === "arabic-coffee-250g");
  const glasses = catalogue.body.find((p) => p.slug === "tea-glasses-6");
  const mint = catalogue.body.find((p) => p.slug === "mint-tea-200g");
  if (!coffee || !glasses || !mint) throw new Error("Run `npm run seed` first.");

  const email = `demo-${Date.now()}@example.ly`;
  const reg = await call("POST", "/customers/register", {
    body: { email, password: "demo-password-1", name: "Fatima", phone: "0913334455" },
  });
  if (reg.status === 429) {
    throw new Error(
      "Registration limit reached (5 new accounts per hour per IP - the framework's anti-abuse limit). " +
        "Restart the demo store (the counter lives in memory) or wait, then run the scenario again."
    );
  }
  show("Register a customer account", reg, `customer ${reg.body.customer.email}, token issued`);
  const auth = { authorization: `Bearer ${reg.body.token}` };

  const cart = await call("POST", "/carts", { headers: auth });
  show("Create a cart (linked to the account)", cart, `cart ${cart.body.id}`);

  const soldOut = await call("POST", `/carts/${cart.body.id}/items`, {
    headers: auth,
    body: { productId: mint.id, quantity: 1 },
  });
  show("Try to add an out-of-stock product", soldOut, soldOut.body.error.message);

  await call("POST", `/carts/${cart.body.id}/items`, { headers: auth, body: { productId: coffee.id, quantity: 2 } });
  const filled = await call("POST", `/carts/${cart.body.id}/items`, {
    headers: auth,
    body: { productId: glasses.id, quantity: 1 },
  });
  show("Add 2 x coffee and 1 x tea glasses", filled, `cart total ${lyd(filled.body.total)}`);

  const options = await call("GET", "/checkout/options");
  show(
    "Checkout options offered by the installed plugins",
    options,
    `shipping: ${options.body.shippingMethods.map((m) => m.id).join(", ")} | payment: ${options.body.paymentMethods.map((m) => m.id).join(", ")}`
  );

  const quote = await call("POST", "/checkout/quote", {
    headers: auth,
    body: { cartId: cart.body.id, shippingAddress: "Tripoli, Al-Andalus", shippingMethod: "flat-rate" },
  });
  show("Price the order with standard delivery", quote, `subtotal ${lyd(quote.body.subtotal)} + shipping ${lyd(quote.body.shippingCost)} = ${lyd(quote.body.total)}`);

  const stockBefore = (await call("GET", `/inventory/${coffee.id}`)).body.quantity;
  const order = await call("POST", "/orders", {
    headers: auth,
    body: {
      cartId: cart.body.id,
      contactName: "Fatima",
      contactPhone: "0913334455",
      shippingAddress: "Tripoli, Al-Andalus",
      shippingMethod: "flat-rate",
      paymentMethod: "cod",
    },
  });
  show("Place the order (cash on delivery)", order, `order ${order.body.id}, total ${lyd(order.body.total)}, payment ${order.body.paymentStatus}: "${order.body.payment.instructions}"`);
  const stockAfter = (await call("GET", `/inventory/${coffee.id}`)).body.quantity;
  console.log(`   coffee stock: ${stockBefore} -> ${stockAfter}`);

  const again = await call("POST", "/orders", {
    headers: auth,
    body: { cartId: cart.body.id, contactName: "Fatima", contactPhone: "0913334455", shippingAddress: "Tripoli, Al-Andalus", shippingMethod: "flat-rate", paymentMethod: "cod" },
  });
  show("Submit the same cart again (double click)", again, again.body.error.message);

  const mine = await call("GET", "/orders", { headers: auth });
  show("Customer lists their own orders", mine, `${mine.body.length} order(s)`);

  const confirmed = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "confirmed" } });
  show("Owner confirms the order", confirmed, `status ${confirmed.body.status}`);
  const shipped = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "shipped" } });
  show("Owner marks it shipped", shipped, `status ${shipped.body.status}`);
  const back = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "pending" } });
  show("Owner tries an invalid transition (shipped -> pending)", back, back.body.error.message);
  const delivered = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "delivered" } });
  const paid = await call("PATCH", `/orders/${order.body.id}/payment`, { headers: OWNER, body: { status: "paid" } });
  show("Delivered and cash collected", paid, `status ${delivered.body.status}, payment ${paid.body.paymentStatus}`);

  const stranger = await call("GET", `/orders/${order.body.id}`);
  show("A stranger tries to open the order", stranger, stranger.body.error.message);

  console.log("\nScenario finished.");
}

main().catch((err) => {
  console.error(`\nScenario failed: ${err.message}`);
  process.exitCode = 1;
});
