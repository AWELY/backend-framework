"use strict";

/**
 * يقدّم ملفات الموقع (المجلد storefront/web): خادم ملفات ثابتة صغير، دون أي اعتمادية.
 *
 * الموقع والـ API خادمان منفصلان: المتصفح يحمّل الصفحات من هنا (المنفذ 5173)، ويستدعي
 * الـ API مباشرة (المنفذ 3000). وهذا معنى Headless. في الإنتاج يمكن وضع هذه الملفات
 * على أي استضافة ملفات ثابتة أو CDN، دون تغيير سطر في الـ API.
 *
 * ثلاث حمايات هنا:
 *   1. سياسة أمان المحتوى (CSP) مع كل رد: تمنع تنفيذ أي سكربت ليس من موقعنا (حماية من XSS).
 *   2. منع الخروج من مجلد web: طلب مثل "/../.env" لا يصل إلى ملفات الأسرار.
 *   3. لا طرق غير GET و HEAD: الموقع للقراءة فقط.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ quiet: true, path: path.join(__dirname, ".env") });

// المجلد الوحيد المسموح تقديم ملفاته.
const ROOT = path.join(__dirname, "web");
const PORT = Number(process.env.WEB_PORT ?? 5173);
// منفذ الـ API، لنسمح للصفحة بالاتصال به في سياسة CSP.
const API_PORT = Number(process.env.PORT ?? 3000);

// نوع كل ملف حسب امتداده (Content-Type)، فيعرف المتصفح كيف يعامله.
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

/**
 * ترويسات الأمان التي تُرسل مع كل ملف.
 *
 * Content-Security-Policy: قائمة بيضاء لما تستطيع الصفحة تحميله:
 *   default-src 'self'        : الافتراضي، من موقعنا فقط.
 *   script-src 'self'         : سكربتات من ملفاتنا فقط. لا سكربت داخل HTML ولا من موقع آخر،
 *                               فحتى لو دسّ مهاجم <script> في اسم منتج، لن يعمل.
 *   style-src و font-src      : أنماطنا، وخطوط Google.
 *   img-src 'self' https: data: : صور من موقعنا، أو من أي رابط https.
 *   connect-src               : الصفحة لا تتصل إلا بموقعنا وبالـ API على المنفذ 3000.
 *   frame-ancestors 'none'    : لا يمكن وضع الموقع داخل iframe في موقع آخر (حماية من Clickjacking).
 *   base-uri و form-action    : تمنع تغيير الرابط الأساسي، وإرسال النماذج إلى موقع آخر.
 * X-Content-Type-Options: nosniff : المتصفح لا "يخمّن" نوع الملف، بل يلتزم بـ Content-Type.
 * Referrer-Policy: same-origin    : لا نرسل رابط الصفحة الحالية إلى مواقع أخرى.
 * Cache-Control: no-cache         : المتصفح يتأكد من وجود نسخة أحدث قبل استخدام المخزّنة.
 */
function securityHeaders(req) {
  // السكربتات والأنماط والصور من هذا الموقع فقط (مع خطوط Google)، والخادم الآخر
  // الوحيد الذي تستطيع الصفحة الاتصال به هو الـ API الخاص بالمتجر.
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

/** يرسل ملفاً بنوعه وترويسات الأمان. createReadStream يرسله على قطع، دون تحميله كله في الذاكرة. */
function send(req, res, status, filePath) {
  const type = TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, { "Content-Type": type, ...securityHeaders(req) });
  // HEAD: الترويسات فقط، دون جسم.
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  // 405 Method Not Allowed، مع ترويسة Allow بالطرق المسموحة.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  // المسار مفكوك الترميز. ترميز معطوب يرمي خطأ، فنرد 400.
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  // "/" أو أي مجلد يعني صفحة index.html فيه.
  if (urlPath.endsWith("/")) urlPath += "index.html";

  // نحسب المسار الكامل داخل ROOT فقط: "/../.env" وما يشبهه لا يخرج أبداً من مجلد web.
  // path.resolve يحل "../" إلى المسار الحقيقي، ثم نتأكد أن النتيجة ما زالت داخل ROOT.
  // هذه الحماية اسمها منع "Path traversal".
  const filePath = path.resolve(ROOT, "." + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  // الملف موجود: نرسله. غير موجود: نرسل صفحة 404.html برمز 404.
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) return send(req, res, 200, filePath);
    send(req, res, 404, path.join(ROOT, "404.html"));
  });
});

// المنفذ مشغول: رسالة واضحة تقول ماذا تفعل، ورمز خروج 1 يجعل start.js يوقف الـ API أيضاً.
server.on("error", (err) => {
  console.error(
    err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use - stop the other server using it, or set a different WEB_PORT in storefront/.env.`
      : err.message,
  );
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`Maa website on http://localhost:${PORT}  (API expected on port ${API_PORT})`);
});
