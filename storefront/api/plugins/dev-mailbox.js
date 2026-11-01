/**
 * "صندوق بريد" للتطوير: إضافة خارجية تستمع للأحداث وترسل الرسائل التي يرسلها متجر حقيقي بالبريد
 * أو SMS، لكنها تحفظها في الذاكرة وتكتبها في السجل بدل إرسالها:
 *   - customer.passwordResetRequested : رابط استعادة كلمة المرور.
 *   - order.created                   : تأكيد الطلب.
 *   - order.deliveryChanged           : "طلبك مع المندوب"، "تم التوصيل".
 *
 * GET /dev/mailbox?to=<بريد أو هاتف> يعرض الرسائل (للتجربة واختبار المتصفح). مفعّل فقط إن كان
 * enabled = true (DEMO_MODE في .env)، فلا يعمل في الإنتاج. في متجر حقيقي: استبدل send ببريد أو SMS.
 *
 * التسليم "مرة واحدة على الأقل": meta.id يمنع حفظ نفس الرسالة مرتين.
 */
function devMailbox({ webOrigin, enabled }) {
  const messages = [];
  const seen = new Set();
  return {
    name: "dev-mailbox",
    version: "1.0.0",
    setup({ extensions, router, logger }) {
      const send = (meta, to, subject, text) => {
        if (seen.has(meta.id)) return;
        seen.add(meta.id);
        messages.unshift({ id: meta.id, to, subject, text, at: new Date().toISOString() });
        messages.length = Math.min(messages.length, 200);
        logger.info(`[dev-mailbox] to ${to}: ${subject}`, { text });
      };

      extensions.on("customer.passwordResetRequested", ({ customer, token }, meta) => {
        send(meta, customer.email, "استعادة كلمة المرور", `${webOrigin}/reset.html?token=${encodeURIComponent(token)}`);
      });
      extensions.on("order.created", ({ order }, meta) => {
        send(meta, order.contactPhone, "تم استلام طلبك", `رقم الطلب ${order.id.slice(0, 8)} — تتبّعه: ${webOrigin}/track.html?id=${order.id}&phone=${encodeURIComponent(order.contactPhone)}`);
      });
      extensions.on("order.deliveryChanged", ({ order, delivery }, meta) => {
        const text = {
          assigned: `طلبك أُسند للمندوب ${delivery.courierName ?? ""}`,
          picked_up: `طلبك في الطريق إليك مع ${delivery.courierName ?? "المندوب"} (${delivery.courierPhone ?? ""})`,
          delivered: "تم توصيل طلبك. شكراً لتسوقك من متجر ماء",
          failed: `لم نستطع توصيل طلبك: ${delivery.note ?? ""}. سنتواصل معك`,
        }[delivery.status];
        send(meta, order.contactPhone, "تحديث التوصيل", text);
      });

      if (enabled) {
        router.get("/dev/mailbox", (req, res) => {
          const to = req.query.get("to");
          res.json(to ? messages.filter((m) => m.to.toLowerCase() === to.toLowerCase() || m.to.replace(/\D/g, "") === to.replace(/\D/g, "")) : []);
        });
      }
    },
  };
}

module.exports = { devMailbox };
