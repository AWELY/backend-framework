const { ORDERS_REPOSITORY, ORDERS_SERVICE, ConflictError, NotFoundError } = require("commerce-framework");
const { query, digits } = require("./shared");

/**
 * إضافة "طلبات الزبون": شيئان يتوقعهما أي زبون في متجر حقيقي، ولا يقدمهما الإطار جاهزين:
 *
 *   1. سجل مراحل الطلب (Timeline): متى أُنشئ، ومتى تأكد، ومتى خرج مع المندوب، ومتى وصل.
 *      الإطار يحفظ الحالة الحالية فقط، لكنه يطلق حدثاً عند كل تغيير (نظام الأحداث في
 *      modules/extensions.ts). هذه الإضافة تستمع للأحداث الثلاثة وتحفظ كل واحد منها كسطر.
 *      أي أنها تبني ميزة كاملة فوق الإطار دون لمس كود وحدة الطلبات، وهذا معنى "نقاط التوسع".
 *
 *   2. إلغاء الزبون لطلبه بنفسه، ما دام "قيد المراجعة" (لم يؤكده المتجر بعد). الإلغاء يمر عبر
 *      خدمة الطلبات في الإطار، فيعود المخزون تلقائياً ويُسجَّل الحدث في السجل.
 *
 * المسارات:
 *   GET  /orders/:id/history   سجل الطلب. يراه: المدير، والزبون صاحب الطلب، والضيف بـ ?phone=
 *   POST /orders/:id/cancel    الزبون صاحب الطلب، أو الضيف بـ ?phone=، والطلب pending فقط
 *
 * من يرى الطلب؟ نفس قاعدة الإطار في GET /orders/:id (رقم الطلب UUID لا يُخمَّن، والهاتف شرط ثانٍ).
 * أي شخص آخر يحصل على 404، لا 403، فلا يعرف أن الطلب موجود.
 */

const historyMigrations = [
  {
    // سطر لكل حدث. kind: نوع الحدث، و from_value و to_value: الحالة قبله وبعده.
    // BIGSERIAL: رقم يزيد تلقائياً، فيبقى ترتيب الأحداث صحيحاً حتى لو تساوى وقتان.
    id: "9300_create_order_events",
    up: `
      CREATE TABLE order_events (
        id         BIGSERIAL PRIMARY KEY,
        order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('created', 'status', 'payment')),
        from_value TEXT,
        to_value   TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX order_events_order_id_idx ON order_events (order_id, id);
    `,
  },
];

function customerOrders() {
  return {
    name: "customer-orders",
    migrations: historyMigrations,
    setup({ router, container, pool, accessControl, authenticateOptional, extensions }) {
      const ordersRepo = () => container.resolve(ORDERS_REPOSITORY);
      const ordersService = () => container.resolve(ORDERS_SERVICE);

      // ---------------- 1. الاستماع للأحداث ----------------
      // الإطار يطلق الأحداث بعد COMMIT، فلا نسجّل أبداً طلباً أُلغي بـ ROLLBACK.
      // وإن فشل الحفظ هنا، يسجّل الإطار الخطأ ويكمل: سجل معطوب لا يُفشل عملية شراء ناجحة.
      const record = (orderId, kind, from, to) =>
        query(pool, "INSERT INTO order_events (order_id, kind, from_value, to_value) VALUES ($1, $2, $3, $4)", [orderId, kind, from, to]);

      extensions.on("order.created", ({ order }) => record(order.id, "created", null, order.status));
      extensions.on("order.statusChanged", ({ order, from }) => record(order.id, "status", from, order.status));
      extensions.on("order.paymentChanged", ({ order, from }) => record(order.id, "payment", from, order.paymentStatus));

      /** المشتري نفسه: الزبون صاحب الطلب، أو الضيف الذي أرسل هاتف الطلب في ?phone=. */
      function isBuyer(req, order) {
        if (req.auth?.role === "customer") return order.customerId !== null && order.customerId === req.auth.userId;
        const phone = req.query.get("phone");
        return phone !== null && digits(phone).length > 0 && digits(phone) === digits(order.contactPhone);
      }

      /** الطلب إن كان المرسل يحق له رؤيته (المدير أو المشتري)، وإلا 404. */
      async function visibleOrder(req) {
        const order = await ordersRepo().findById(req.params.id);
        const allowed = order && (accessControl.can(req.auth?.role, "orders:read-all") || isBuyer(req, order));
        if (!allowed) throw new NotFoundError("Order not found");
        return order;
      }

      // ---------------- 2. المسارات ----------------

      // سجل الطلب بالترتيب. الطلبات التي سبقت تثبيت هذه الإضافة ليس لها سطور، فالموقع يعرض
      // عندها وقت إنشاء الطلب فقط (createdAt من الطلب نفسه).
      router.get("/orders/:id/history", authenticateOptional, async (req, res) => {
        const order = await visibleOrder(req);
        const { rows } = await query(
          pool,
          "SELECT kind, from_value, to_value, created_at FROM order_events WHERE order_id = $1 ORDER BY id",
          [order.id]
        );
        res.json(rows.map((r) => ({ kind: r.kind, from: r.from_value, to: r.to_value, at: r.created_at })));
      });

      /**
       * الزبون يلغي طلبه قبل أن يؤكده المتجر. المدير لا يستخدم هذا المسار، بل مسار الإطار
       * PATCH /orders/:id/status (يستطيع إلغاء الطلب المؤكد أيضاً).
       *
       * ملاحظة صريحة: بين فحص "pending" هنا واستدعاء changeStatus لحظة قصيرة جداً قد يؤكد فيها
       * المدير الطلب، وآلة الحالات في الإطار تسمح بإلغاء المؤكد أيضاً. الإطار لا يوفر اليوم شرط
       * "الحالة المتوقعة" في changeStatus، وإضافته هناك تغلق هذه النافذة نهائياً.
       */
      router.post("/orders/:id/cancel", authenticateOptional, async (req, res) => {
        const order = await ordersRepo().findById(req.params.id);
        if (!order || !isBuyer(req, order)) throw new NotFoundError("Order not found");
        if (order.status !== "pending") {
          throw new ConflictError("Only orders under review can be cancelled", { status: order.status });
        }
        res.json(await ordersService().changeStatus(order.id, "cancelled"));
      });
    },
  };
}

module.exports = { customerOrders };
