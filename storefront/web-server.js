"use strict";

/**
 * Serves the website (storefront/web) - a tiny static file server with no
 * dependencies. The website and the API are SEPARATE servers: the browser
 * loads pages from here and calls the API directly (that is what "headless"
 * means). In production these files could live on any static host or CDN.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ quiet: true, path: path.join(__dirname, ".env") });

const ROOT = path.join(__dirname, "web");
const PORT = Number(process.env.WEB_PORT ?? 5173);
const API_PORT = Number(process.env.PORT ?? 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function securityHeaders(req) {
  // Scripts, styles and images may only come from this site (plus Google Fonts);
  // the only other server the page may talk to is the store's API.
  const host = (req.headers.host ?? "localhost").split(":")[0];
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' https: data:",
      `connect-src 'self' http://${host}:${API_PORT}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-cache",
  };
}

function send(req, res, status, filePath) {
  const type = TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, { "Content-Type": type, ...securityHeaders(req) });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";

  // Resolve inside ROOT only: "/../.env" and similar never leave the web folder.
  const filePath = path.resolve(ROOT, "." + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) return send(req, res, 200, filePath);
    send(req, res, 404, path.join(ROOT, "404.html"));
  });
});

server.on("error", (err) => {
  console.error(
    err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use - stop the other server using it, or set a different WEB_PORT in storefront/.env.`
      : err.message,
  );
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`AMA website on http://localhost:${PORT}  (API expected on port ${API_PORT})`);
});
