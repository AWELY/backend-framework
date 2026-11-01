import type { ServerResponse } from "node:http";

/**
 * شكل الرد كما يستخدمه أي handler في الإطار.
 *
 * Node يعطينا الرد الخام من نوع ServerResponse. لإرسال JSON به نحتاج ثلاثة أسطر:
 *   res.statusCode = 201;
 *   res.setHeader("Content-Type", "application/json; charset=utf-8");
 *   res.end(JSON.stringify(data));
 *
 * و AppResponse هو نفس الرد مضافاً إليه ثلاث دوال مختصرة، فيصبح ما سبق سطراً واحداً:
 *   res.status(201).json(data);
 */
export interface AppResponse extends ServerResponse {
  /** تضبط رمز الحالة فقط ولا ترسل شيئاً، وترجع الرد نفسه ليمكن كتابة .json() بعدها. */
  status(code: number): AppResponse;
  /** ترسل البيانات بصيغة JSON وتنهي الرد. */
  json(data: unknown): void;
  /** ترسل نصاً عادياً وتنهي الرد. */
  send(body: string): void;
}

/**
 * تضيف الدوال الثلاث إلى كائن الرد الحقيقي نفسه، ولا تنشئ كائناً جديداً يغلّفه.
 *
 * لماذا؟ حتى تبقى كل دوال Node الأصلية تعمل كما هي: setHeader و headersSent
 * و on("finish")، والأخيرة يعتمد عليها middleware/request-logger.ts ليعرف متى انتهى الرد.
 *
 * تُستدعى مرة واحدة لكل طلب، في أول createServer (server.ts).
 */
export function enhanceResponse(res: ServerResponse): AppResponse {
  // كلمة "as" لا تغيّر شيئاً وقت التشغيل، بل تخبر TypeScript فقط أن يعامل الكائن
  // كأنه AppResponse. أي أن appRes و res هما الكائن نفسه، وليس نسخة منه.
  const appRes = res as AppResponse;

  // status تضبط الرمز ثم ترجع الكائن نفسه. إرجاعه هو ما يسمح بكتابة
  // res.status(201).json(...) في سطر واحد، وهذا اسمه Method chaining.
  appRes.status = (code: number): AppResponse => {
    appRes.statusCode = code;
    return appRes;
  };

  // json تخبر العميل أن الجسم JSON، و charset=utf-8 حتى تصل الحروف العربية سليمة.
  // JSON.stringify تحوّل الكائن إلى نص، و end ترسله وتغلق الرد، فلا يمكن الإرسال بعدها.
  // لا تغيّر رمز الحالة: إن لم تُستدعَ status قبلها يبقى الرمز الافتراضي 200.
  appRes.json = (data: unknown): void => {
    appRes.setHeader("Content-Type", "application/json; charset=utf-8");
    appRes.end(JSON.stringify(data));
  };

  // send لإرسال نص عادي. لا تكتب فوق Content-Type إن ضبطه أحد قبلها
  // (مثلاً "text/html")، وإلا تجعله نصاً عادياً.
  appRes.send = (body: string): void => {
    if (!appRes.hasHeader("Content-Type")) {
      appRes.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    appRes.end(body);
  };

  return appRes;
}
