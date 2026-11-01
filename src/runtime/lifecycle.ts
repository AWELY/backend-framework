import type { Logger } from "../engine/logger";

/** ما تحتاجه installShutdownHandlers من التطبيق. */
export interface Closable {
  close(options?: { timeoutMs?: number }): Promise<void>;
  logger: Logger;
}

/**
 * إيقاف لطيف (Graceful shutdown) عند إشارات النظام: SIGTERM (يرسلها Docker و Kubernetes و systemd
 * قبل إيقاف الحاوية) و SIGINT (Ctrl+C في الطرفية).
 *
 * بدونه: الإشارة تقتل العملية فوراً، فينقطع شراء في منتصفه عند الزبون، وتبقى اتصالات القاعدة معلقة.
 * معه: app.close يتوقف عن قبول الطلبات (و /readyz يرد 503 فيتوقف موازن الأحمال عن الإرسال)،
 * وينتظر الطلبات الجارية حتى timeoutMs، ويوقف العامل في الخلفية بعد دورته الحالية، ثم يغلق القاعدة.
 * إشارة ثانية أثناء الإيقاف تخرج فوراً (لمن ضغط Ctrl+C مرتين).
 *
 * مثال (cli/templates/index.js.template):
 *   await app.listen(config.port);
 *   installShutdownHandlers(app, { timeoutMs: config.shutdownTimeoutMs });
 */
export function installShutdownHandlers(
  app: Closable,
  options: { signals?: NodeJS.Signals[]; timeoutMs?: number; exit?: (code: number) => void } = {}
): () => void {
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      app.logger.warn(`Received ${signal} again, exiting immediately`);
      exit(1);
      return;
    }
    shuttingDown = true;
    app.logger.info(`Received ${signal}, shutting down gracefully`);
    app
      .close({ timeoutMs: options.timeoutMs })
      .then(() => {
        app.logger.info("Shutdown complete");
        exit(0);
      })
      .catch((err: unknown) => {
        app.logger.error("Shutdown failed", { message: err instanceof Error ? err.message : String(err) });
        exit(1);
      });
  };

  for (const signal of signals) process.on(signal, onSignal);
  // يرجع دالة تزيل المستمعين (للاختبارات).
  return () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
}
