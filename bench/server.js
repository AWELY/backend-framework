"use strict";

/**
 * The server under test, started by bench/run.js as a SEPARATE process so the
 * load generator and the server do not share a CPU core's event loop.
 * Uses the compiled framework (dist/), exactly like a real store.
 */
const { createCommerceApp, Logger } = require("../dist/index");

const app = createCommerceApp({
  databaseUrl: process.env.BENCH_DATABASE_URL,
  ownerApiKey: "bench-owner-key-that-is-long-enough-000000",
  authTokenSecret: "bench-token-secret-that-is-long-enough-00000",
  logger: new Logger("error"),
});

// Bench-only route: lets the runner read this process's memory use. With
// --expose-gc it first runs a full garbage collection, so the numbers show
// memory actually RETAINED (a leak would show here), not garbage not yet collected.
app.router.get("/bench/memory", (_req, res) => {
  if (typeof global.gc === "function") global.gc();
  const m = process.memoryUsage();
  res.json({ rss: m.rss, heapUsed: m.heapUsed });
});

app.listen(Number(process.env.PORT)).then(() => {
  if (process.send) process.send("ready");
});
