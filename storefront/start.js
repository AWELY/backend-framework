"use strict";

/**
 * `npm start` - runs the API and the website together in one terminal.
 * Ctrl+C stops both. If either one crashes, the other is stopped too.
 */

const { spawn } = require("node:child_process");
const { join } = require("node:path");

const services = [
  { name: "api", file: join(__dirname, "api", "index.js") },
  { name: "web", file: join(__dirname, "web-server.js") },
];

const children = services.map(({ name, file }) => {
  const child = spawn(process.execPath, [file], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join("\n") + "\n";
  child.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (exit code ${code})`);
    for (const other of children) if (other !== child && other.exitCode === null) other.kill();
    process.exitCode = code ?? 0;
  });
  return child;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
}
