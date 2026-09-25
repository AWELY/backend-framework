"use strict";

/**
 * One command that checks EVERYTHING still works, end to end:
 *
 *   npm run verify
 *
 *   0. prerequisites  - Node >= 24, .env, a reachable test database
 *   1. build          - TypeScript compiles
 *   2. tests          - all unit + integration tests (real PostgreSQL)
 *   3. CLI            - generate a new store, install, migrate, start, call it
 *   4. demo store     - migrate, seed, start, run the 16-step shopping scenario
 *
 * Every database step uses TEST_DATABASE_URL (it is wiped), never your
 * development data. Temporary folders are deleted at the end, pass or fail.
 */

require("dotenv").config({ quiet: true });
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");

const ROOT = resolve(__dirname, "..");
const TEST_DB = process.env.TEST_DATABASE_URL;
const results = [];

const secret = () => randomBytes(32).toString("hex");

function run(command, args, cwd, extraEnv = {}) {
  const options = { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" };
  // On Windows npm is a .cmd script and must go through the shell. Passing it as
  // ONE command string (our arguments are fixed, not user input) avoids Node's
  // DEP0190 warning about unescaped shell arguments.
  const res =
    command === "npm" && process.platform === "win32"
      ? spawnSync(`npm ${args.join(" ")}`, { ...options, shell: true })
      : spawnSync(command, args, options);
  if (res.status !== 0) {
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(`"${command} ${args.join(" ")}" failed:\n${output}`);
  }
  return res.stdout ?? "";
}

function freePort() {
  return new Promise((ok) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/** Starts `node <file>` and resolves once GET /health answers 200. */
async function startServer(file, cwd, env) {
  const child = spawn(process.execPath, [file], { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://localhost:${env.PORT}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/health`)).status === 200) return { child, base, log: () => log };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopServer({ child });
  throw new Error(`server did not become healthy:\n${log}`);
}

/** Stops a server and WAITS until the process is gone (on Windows it keeps its folder locked until then). */
async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((ok) => server.child.once("exit", ok));
  server.child.kill();
  await exited;
}

/** Deletes a temp folder, retrying briefly if Windows still has a file locked. */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.log(`\n    warning: could not delete ${dir} (${err.code}) - delete it by hand`);
  }
}

async function resetTestDatabase() {
  const { Pool } = require(join(ROOT, "node_modules", "pg"));
  const pool = new Pool({ connectionString: TEST_DB });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await pool.end();
  }
}

async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n[${results.length}] ${name} ... `);
  try {
    const detail = await fn();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ name, ok: true });
    console.log(`PASS (${seconds}s)${detail ? `\n    ${detail}` : ""}`);
    return true;
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL\n    ${String(err.message ?? err).split("\n").join("\n    ")}`);
    return false;
  }
}

async function main() {
  console.log("Verifying the commerce framework end to end.");

  const ready = await step("prerequisites", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) throw new Error(`Node.js 24+ required, found ${process.version}`);
    if (!existsSync(join(ROOT, ".env"))) throw new Error("No .env file - copy .env.example to .env and fill it in.");
    if (!TEST_DB) throw new Error("TEST_DATABASE_URL is missing from .env.");
    if (!/test/i.test(new URL(TEST_DB).pathname)) {
      throw new Error("TEST_DATABASE_URL must point to a database whose name contains 'test' (it gets wiped).");
    }
    const { Pool } = require(join(ROOT, "node_modules", "pg"));
    const pool = new Pool({ connectionString: TEST_DB });
    try {
      const { rows } = await pool.query("SELECT version()");
      return `${process.version}, ${rows[0].version.split(",")[0]}`;
    } catch (err) {
      throw new Error(`Cannot reach the test database: ${err.message}\n(Is the PostgreSQL service running?)`);
    } finally {
      await pool.end();
    }
  });
  if (!ready) return;

  const built = await step("build (TypeScript)", async () => {
    run("npm", ["run", "build"], ROOT);
  });
  if (!built) return;

  await step("unit + integration tests", async () => {
    const out = run("npm", ["test"], ROOT);
    const count = (label) => Number((out.match(new RegExp(`ℹ ${label} (\\d+)`)) ?? [])[1] ?? NaN);
    const [tests, pass, fail] = [count("tests"), count("pass"), count("fail")];
    if (fail !== 0 || !(pass > 0)) throw new Error(`tests: ${tests}, pass: ${pass}, fail: ${fail}`);
    return `${pass}/${tests} tests passed`;
  });

  const storeName = `verify-store-${randomBytes(3).toString("hex")}`;
  const storeDir = resolve(ROOT, "..", storeName);
  await step("CLI: create a store, install, migrate, start, call it", async () => {
    let server;
    try {
      run(process.execPath, [join(ROOT, "cli", "index.js"), "create", storeName], ROOT);
      if (!existsSync(join(storeDir, ".env"))) throw new Error("the CLI did not write a .env");
      run("npm", ["install", "--loglevel=error"], storeDir);
      await resetTestDatabase();
      const env = { DATABASE_URL: TEST_DB, PORT: String(await freePort()) };
      const migrated = run("npm", ["run", "migrate", "--silent"], storeDir, env);
      if (!/migration\(s\) applied/.test(migrated)) throw new Error(`unexpected migrate output: ${migrated}`);
      server = await startServer("index.js", storeDir, env);
      const options = await (await fetch(`${server.base}/checkout/options`)).json();
      if (!options.paymentMethods?.some((m) => m.id === "cod")) throw new Error("plugins are not installed in the generated store");
      return `generated ${storeName}, health OK, plugins OK`;
    } finally {
      await stopServer(server);
      removeDir(storeDir);
    }
  });

  const demoDir = join(ROOT, "examples", "demo-store");
  await step("demo store: migrate, seed, start, 16-step scenario", async () => {
    let server;
    try {
      // The demo holds a COPY of the framework: refresh it so it tests the current build.
      rmSync(join(demoDir, "node_modules", "commerce-framework"), { recursive: true, force: true });
      run("npm", ["install", "--loglevel=error"], demoDir);
      await resetTestDatabase();
      const env = {
        DATABASE_URL: TEST_DB,
        PORT: String(await freePort()),
        OWNER_API_KEY: secret(),
        AUTH_TOKEN_SECRET: secret(),
      };
      run("npm", ["run", "migrate", "--silent"], demoDir, env);
      const seeded = run("npm", ["run", "seed", "--silent"], demoDir, env);
      if (!/Seeded \d+ record/.test(seeded)) throw new Error(`unexpected seed output: ${seeded}`);
      server = await startServer("index.js", demoDir, env);
      const out = run("npm", ["run", "scenario", "--silent"], demoDir, env);
      const steps = (out.match(/^\d+\. /gm) ?? []).length;
      if (!/Scenario finished/.test(out) || steps !== 16) throw new Error(`scenario ended after ${steps} steps:\n${out}`);
      if (/\bERROR\b/.test(server.log())) throw new Error(`server logged errors:\n${server.log()}`);
      return "16/16 steps, no server errors";
    } finally {
      await stopServer(server);
    }
  });
}

main()
  .catch((err) => {
    results.push({ name: "verify script", ok: false });
    console.error(err);
  })
  .finally(async () => {
    // Leave the test database empty and clean for the next run.
    if (TEST_DB) await resetTestDatabase().catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log("\n" + "=".repeat(60));
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    console.log("=".repeat(60));
    console.log(failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
