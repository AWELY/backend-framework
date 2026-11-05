const {
  ORDERS_SERVICE,
  ORDERS_REPOSITORY,
  validateBody,
  requirePermission,
  withTransaction,
  isUuid,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require("commerce-framework");
const { query } = require("./shared");
const { STAFF_REPOSITORY, activeStaff, activeAdminGuard } = require("./staff");

/**
 * إضافة "التوصيل بالمندوبين": المدير يعيّن مندوباً لكل طلب، والمندوب يستلمه من المحل ويسلّمه
 * للزبون ويحصّل المبلغ نقداً.
 *
 * رحلة الطلب في هذا المتجر (حالات الإطار نفسها، لا حالات جديدة):
 *
 *   pending ──(المدير يؤكد)──▶ confirmed ──(المدير يعيّن مندوباً)
 *                                   │
 *                       (المندوب: "استلمت الطلب من المحل")
 *                                   ▼
 *                                shipped ──(المندوب: "تم التسليم")──▶ delivered + الدفع "paid"
 *
 * الإضافة لا تغيّر حالة الطلب بنفسها في قاعدة البيانات أبداً. تطلب ذلك من خدمة الطلبات في الإطار
 * (ORDERS_SERVICE من حاوية الـ DI)، فتبقى قواعد الإطار سارية: آلة الحالات (لا تسليم قبل الشحن)،
 * وقفل صف الطلب، وإعادة المخزون عند الإلغاء، وإطلاق الأحداث (order.statusChanged) التي تسجّلها
 * إضافة سجل الطلب (customer-orders.js).
 *
 * المسارات:
 *   للمدير (deliveries:manage):
 *     PUT    /orders/:id/courier          { courierId }: تعيين مندوب أو تغييره (الطلب "مؤكد" فقط)
 *     DELETE /orders/:id/courier          إلغاء التعيين (قبل أن يستلم المندوب الطلب)
 *     GET    /deliveries?orderIds=a,b     معلومات التوصيل لطلبات محددة (لجدول الطلبات في اللوحة)
 *     GET    /deliveries/couriers         لكل مندوب: طلباته الجارية، وما سلّمه اليوم، والنقد الذي معه
 *   للمندوب (deliveries:work):
 *     GET    /courier/deliveries?scope=active|done   مهامه الجارية، أو المنتهية
 *     POST   /courier/deliveries/:orderId/pickup     استلم الطلب من المحل (يصبح الطلب shipped)
 *     POST   /courier/deliveries/:orderId/deliver    سلّمه للزبون (delivered، والدفع النقدي paid)
 *     POST   /courier/deliveries/:orderId/note       { note }: إبلاغ المدير بمشكلة (الزبون لا يرد...)
 *
 * المدير يستطيع أيضاً تغيير الحالة مباشرة من مسار الإطار (PATCH /orders/:id/status)، مثلاً "شُحن بطريقة
 * أخرى" أو "تم التسليم". الإضافة تستمع لحدث order.statusChanged لتبقى بياناتها متسقة مع ذلك
 * (انظر "الاستماع لتغييرات الحالة" أدناه).
 *
 * خيارات الإضافة:
 *   cashPaymentMethods : طرق الدفع التي يحصّلها المندوب نقداً. الافتراضي ["cod"] (إضافة الإطار).
 *   timeZone           : لحساب "اليوم" في ملخص المندوبين. الافتراضي توقيت ليبيا.
 */

const deliveryMigrations = [
  {
    // 9200 بعد 9100 (جدول staff)، لأن courier_id يشير إليه.
    //   order_id       : المفتاح الأساسي، فلكل طلب مندوب واحد على الأكثر. حذف الطلب يحذف صفه.
    //   courier_id     : ON DELETE RESTRICT: لا يمكن حذف مندوب له توصيلات (يُوقَف حسابه بدل الحذف).
    //   picked_up_at   : متى استلم الطلب من المحل. بعده لا يمكن تغيير المندوب.
    //   delivered_at   : متى سلّمه. cash_collected: المبلغ الذي حصّله نقداً (بالدرهم).
    //   note و note_at : آخر مشكلة أبلغ عنها المندوب.
    id: "9200_create_deliveries",
    up: `
      CREATE TABLE deliveries (
        order_id       UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        courier_id     UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
        assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        picked_up_at   TIMESTAMPTZ,
        delivered_at   TIMESTAMPTZ,
        cash_collected INTEGER CHECK (cash_collected >= 0),
        note           TEXT,
        note_at        TIMESTAMPTZ
      );
      CREATE INDEX deliveries_courier_id_idx ON deliveries (courier_id);
    `,
  },
];

const assignSchema = {
  courierId: { type: "string", minLength: 36, maxLength: 36 },
};
const noteSchema = {
  note: { type: "string", minLength: 2, maxLength: 500 },
};

/** صف من deliveries مع اسم المندوب وهاتفه، إلى شكل الـ API. */
function toDelivery(row) {
  return {
    orderId: row.order_id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    courierPhone: row.courier_phone,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    cashCollected: row.cash_collected,
    note: row.note,
    noteAt: row.note_at,
  };
}

// استعلام التوصيل مع اسم المندوب: يتكرر في أكثر من مسار.
const DELIVERY_SELECT = `
  SELECT d.*, s.name AS courier_name, s.phone AS courier_phone
    FROM deliveries d JOIN staff s ON s.id = d.courier_id`;

function courierDelivery({ cashPaymentMethods = ["cod"], timeZone = "Africa/Tripoli" } = {}) {
  return {
    name: "courier-delivery",
    migrations: deliveryMigrations,
    setup({ router, container, pool, accessControl, authenticate, extensions }) {
      const staffRepo = () => container.resolve(STAFF_REPOSITORY);
      // خدمة الطلبات من الإطار: الطريق الوحيد لتغيير حالة طلب أو حالة دفعه.
      const orders = () => container.resolve(ORDERS_SERVICE);
      const ordersRepo = () => container.resolve(ORDERS_REPOSITORY);
      const canManage = requirePermission(accessControl, "deliveries:manage");
      const canWork = requirePermission(accessControl, "deliveries:work");
      const adminActive = activeAdminGuard(staffRepo);

      /** معلومات التوصيل لطلب واحد مع اسم المندوب، أو null إن لم يُعيَّن له مندوب. */
      async function findDelivery(db, orderId) {
        const { rows } = await query(db, `${DELIVERY_SELECT} WHERE d.order_id = $1`, [orderId]);
        return rows[0] ? toDelivery(rows[0]) : null;
      }

      // ---------------- الاستماع لتغييرات الحالة ----------------
      /**
       * حين يغيّر المدير الحالة من مسار الإطار مباشرة (لا من تطبيق المندوب):
       *   - shipped والمندوب لم يستلم الطلب بعد: "شُحن بطريقة أخرى"، فالمندوب لم يعد مسؤولاً عنه.
       *     نحذف التعيين، وإلا لظهر الطلب في تطبيقه "في الطريق" وسجّل تسليماً ونقداً لم يحصّله.
       *     (في مسار الاستلام نفسه نسجّل picked_up_at قبل تغيير الحالة، فلا يحذفه هذا الشرط.)
       *   - delivered: نختم وقت التسليم إن لم يُختم، فلا يبقى الطلب "جارياً" في قوائم التوصيل.
       * الإطار يطلق الحدث بعد COMMIT، وفشل المستمع يُسجَّل ولا يُفشل تغيير الحالة نفسه.
       */
      extensions.on("order.statusChanged", async ({ order }) => {
        if (order.status === "shipped") {
          await query(pool, "DELETE FROM deliveries WHERE order_id = $1 AND picked_up_at IS NULL", [order.id]);
        } else if (order.status === "delivered") {
          await query(pool, "UPDATE deliveries SET delivered_at = coalesce(delivered_at, now()) WHERE order_id = $1", [order.id]);
        }
      });

      // ---------------- مسارات المدير ----------------

      /**
       * تعيين مندوب أو تغييره، في معاملة واحدة:
       *   1. نقفل صف الطلب (FOR UPDATE)، وهو نفس القفل الذي تأخذه خدمة الطلبات في الإطار عند تغيير
       *      الحالة، فلا يتغير الطلب (مثلاً يُلغى) في منتصف التعيين.
       *   2. الطلب يجب أن يكون "مؤكداً": لا نرسل مندوباً لطلب لم يراجعه المدير بعد، ولا لطلب انتهى.
       *   3. المندوب يجب أن يكون حساباً نشطاً بدور courier.
       *   4. INSERT ... ON CONFLICT: إن كان للطلب مندوب، نستبدله، لكن فقط إن لم يستلم الطلب بعد
       *      (WHERE picked_up_at IS NULL). إن كان قد استلمه، لا يرجع أي صف، فنرد 409.
       */
      router.put("/orders/:id/courier", authenticate, canManage, adminActive, validateBody(assignSchema), async (req, res) => {
        const orderId = req.params.id;
        const { courierId } = req.body;
        if (!isUuid(orderId)) throw new NotFoundError("Order not found");
        const delivery = await withTransaction(pool, async (client) => {
          const { rows } = await query(client, "SELECT status, shipping_method FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
          if (!rows[0]) throw new NotFoundError("Order not found");
          if (rows[0].status !== "confirmed") {
            throw new ConflictError("Only confirmed orders can be assigned to a courier", { status: rows[0].status });
          }
          // طلب "الاستلام من المحل" يأخذه الزبون بنفسه، فلا معنى لمندوب له.
          if (rows[0].shipping_method === "pickup") throw new ConflictError("Pickup orders do not need a courier");
          const courier = isUuid(courierId)
            ? (await query(client, "SELECT role, is_active FROM staff WHERE id = $1", [courierId])).rows[0]
            : undefined;
          if (!courier || courier.role !== "courier" || !courier.is_active) {
            throw new ValidationError("Validation failed", [{ field: "courierId", message: "must be an active courier" }]);
          }
          const upsert = await query(
            client,
            `INSERT INTO deliveries (order_id, courier_id) VALUES ($1, $2)
             ON CONFLICT (order_id) DO UPDATE
               SET courier_id = EXCLUDED.courier_id, assigned_at = now(), note = NULL, note_at = NULL
               WHERE deliveries.picked_up_at IS NULL
             RETURNING order_id`,
            [orderId, courierId]
          );
          if (upsert.rows.length === 0) throw new ConflictError("The courier has already picked up this order");
          return findDelivery(client, orderId);
        });
        res.json(delivery);
      });

      // إلغاء التعيين: مسموح فقط قبل أن يستلم المندوب الطلب من المحل.
      router.delete("/orders/:id/courier", authenticate, canManage, adminActive, async (req, res) => {
        const orderId = req.params.id;
        if (!isUuid(orderId)) throw new NotFoundError("Order not found");
        const current = await findDelivery(pool, orderId);
        if (!current) throw new NotFoundError("This order has no courier");
        const { rowCount } = await query(pool, "DELETE FROM deliveries WHERE order_id = $1 AND picked_up_at IS NULL", [orderId]);
        if (rowCount === 0) throw new ConflictError("The courier has already picked up this order");
        res.status(204).end();
      });

      /**
       * معلومات التوصيل لعدة طلبات دفعة واحدة: صفحة الطلبات في اللوحة تعرض 20 طلباً، فترسل
       * أرقامها هنا في طلب واحد بدل 20 طلباً. بلا ?orderIds تعطي التوصيلات الجارية فقط.
       * نقبل حتى 100 رقم، وكل ما ليس UUID يُتجاهل.
       */
      router.get("/deliveries", authenticate, canManage, adminActive, async (req, res) => {
        const param = req.query.get("orderIds");
        if (param !== null) {
          const ids = param.split(",").filter(isUuid).slice(0, 100);
          if (ids.length === 0) return res.json([]);
          const { rows } = await query(pool, `${DELIVERY_SELECT} WHERE d.order_id = ANY($1::uuid[])`, [ids]);
          return res.json(rows.map(toDelivery));
        }
        // "الجارية": الطلب ما زال مؤكداً أو في الطريق. طلب أُلغي بعد تعيينه ليس جارياً، حتى لو لم يُختم تسليمه.
        const { rows } = await query(
          pool,
          `${DELIVERY_SELECT} JOIN orders o ON o.id = d.order_id
            WHERE d.delivered_at IS NULL AND o.status IN ('confirmed', 'shipped') ORDER BY d.assigned_at`
        );
        res.json(rows.map(toDelivery));
      });

      /**
       * ملخص لكل مندوب (للوحة التحكم): كم طلباً معه الآن، وكم سلّم اليوم، وكم نقداً حصّل اليوم.
       * "اليوم" بتوقيت المتجر (timeZone)، لا بتوقيت الخادم: AT TIME ZONE يحوّل الوقت قبل المقارنة.
       * FILTER (WHERE ...) تحسب المجموع لصفوف محددة فقط داخل نفس الاستعلام.
       */
      router.get("/deliveries/couriers", authenticate, canManage, adminActive, async (_req, res) => {
        const { rows } = await query(
          pool,
          `SELECT s.id, s.name, s.phone, s.is_active,
                  count(d.order_id) FILTER (WHERE d.delivered_at IS NULL AND o.status IN ('confirmed', 'shipped'))::int AS active,
                  count(d.order_id) FILTER (WHERE (d.delivered_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)::int AS delivered_today,
                  coalesce(sum(d.cash_collected) FILTER (WHERE (d.delivered_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0)::bigint AS cash_today
             FROM staff s
             LEFT JOIN deliveries d ON d.courier_id = s.id
             LEFT JOIN orders o ON o.id = d.order_id
            WHERE s.role = 'courier'
            GROUP BY s.id
            ORDER BY s.is_active DESC, s.name`,
          [timeZone]
        );
        // bigint يصل من مكتبة pg نصاً (لأنه قد يتجاوز أرقام JavaScript)، فنحوّله إلى رقم.
        res.json(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            isActive: r.is_active,
            active: r.active,
            deliveredToday: r.delivered_today,
            cashToday: Number(r.cash_today),
          }))
        );
      });

      // ---------------- مسارات المندوب ----------------

      /**
       * مهام المندوب. لا نرسل له كل الطلب، بل ما يحتاجه للتوصيل فقط: الاسم والهاتف والعنوان،
       * وأسماء المنتجات وكمياتها، والمبلغ الذي يحصّله. لا أسعار القطع ولا بيانات الزبون الأخرى
       * (مبدأ تقليل البيانات، نفس مبدأ الإطار مع إضافات الشحن).
       *
       *   scope=active : الطلبات التي معه الآن (مؤكدة أو مشحونة).
       *   scope=done   : ما انتهى في آخر 7 أيام (سُلّم أو أُلغي بعد تعيينه)، حتى 50 طلباً. لا نُبقي
       *                  أسماء الزبائن وعناوينهم في هاتف المندوب أكثر من ذلك.
       */
      router.get("/courier/deliveries", authenticate, canWork, async (req, res) => {
        const me = await activeStaff(staffRepo(), req, ["courier"]);
        const done = req.query.get("scope") === "done";
        const { rows } = await query(
          pool,
          `SELECT o.id, o.status, o.contact_name, o.contact_phone, o.shipping_address, o.shipping_city,
                  o.total, o.payment_method, o.payment_status, o.created_at,
                  d.assigned_at, d.picked_up_at, d.delivered_at, d.cash_collected, d.note
             FROM deliveries d JOIN orders o ON o.id = d.order_id
            WHERE d.courier_id = $1 AND o.status ${done
              ? "IN ('delivered', 'cancelled') AND coalesce(d.delivered_at, o.updated_at) > now() - interval '7 days'"
              : "IN ('confirmed', 'shipped')"}
            ORDER BY ${done ? "coalesce(d.delivered_at, o.updated_at) DESC LIMIT 50" : "d.assigned_at"}`,
          [me.id]
        );
        // سطور كل الطلبات في استعلام واحد (لا استعلام لكل طلب: مشكلة N+1).
        const items = rows.length
          ? (await query(pool, "SELECT order_id, product_name, quantity FROM order_items WHERE order_id = ANY($1::uuid[])", [rows.map((r) => r.id)])).rows
          : [];
        res.json(
          rows.map((r) => {
            // ما يحصّله المندوب: الإجمالي إن كان الدفع نقداً ولم يُدفع بعد، وإلا لا شيء.
            const collect = cashPaymentMethods.includes(r.payment_method) && ["pending", "unpaid"].includes(r.payment_status) && r.status !== "cancelled";
            return {
              orderId: r.id,
              status: r.status,
              contactName: r.contact_name,
              contactPhone: r.contact_phone,
              shippingAddress: r.shipping_address,
              shippingCity: r.shipping_city,
              total: r.total,
              amountToCollect: collect ? r.total : 0,
              paymentStatus: r.payment_status,
              items: items.filter((i) => i.order_id === r.id).map((i) => ({ productName: i.product_name, quantity: i.quantity })),
              createdAt: r.created_at,
              assignedAt: r.assigned_at,
              pickedUpAt: r.picked_up_at,
              deliveredAt: r.delivered_at,
              cashCollected: r.cash_collected,
              note: r.note,
            };
          })
        );
      });

      /** توصيل هذا المندوب لهذا الطلب، مع حالة الطلب. طلب ليس له يعطي 404 (لا يكشف وجوده). */
      async function myDelivery(me, orderId) {
        if (!isUuid(orderId)) throw new NotFoundError("Delivery not found");
        const { rows } = await query(
          pool,
          `SELECT d.*, o.status FROM deliveries d JOIN orders o ON o.id = d.order_id
            WHERE d.order_id = $1 AND d.courier_id = $2`,
          [orderId, me.id]
        );
        if (!rows[0]) throw new NotFoundError("Delivery not found");
        return rows[0];
      }

      /**
       * "استلمت الطلب من المحل": يصبح الطلب "في الطريق" (shipped).
       *
       * الترتيب مهم:
       *   1. نسجّل الاستلام أولاً بتحديث مشروط (picked_up_at IS NULL)، وهذا "حجز" ذري: من هذه
       *      اللحظة لا يستطيع المدير تغيير المندوب (شرط WHERE في مسار التعيين).
       *   2. ثم نطلب من خدمة الإطار تغيير الحالة. إن رفضت (مثلاً أُلغي الطلب في الأثناء: 409)،
       *      نتراجع عن الخطوة 1، فلا يبقى طلب ملغى "مستلَماً".
       * لماذا ليس في معاملة واحدة؟ changeStatus في الإطار تفتح معاملتها الخاصة، ولا تقبل اتصالاً
       * من الخارج. (ملاحظة للإطار: قبول client اختياري فيها يجعل هذا ذرياً بالكامل.)
       *
       * قابل للإعادة: إن توقف الخادم بين الخطوتين، يبقى الطلب "مؤكداً" وعليه حجز. ضغط المندوب
       * مرة أخرى يتجاوز الخطوة 1 (الحجز له أصلاً) ويكمل الخطوة 2، بدل أن يعلق الطلب.
       */
      router.post("/courier/deliveries/:orderId/pickup", authenticate, canWork, async (req, res) => {
        const me = await activeStaff(staffRepo(), req, ["courier"]);
        const current = await myDelivery(me, req.params.orderId);
        if (current.status !== "confirmed") {
          throw new ConflictError("This order is not waiting for pickup", { status: current.status });
        }
        let claimedNow = false;
        if (!current.picked_up_at) {
          const claimed = await query(
            pool,
            "UPDATE deliveries SET picked_up_at = now() WHERE order_id = $1 AND courier_id = $2 AND picked_up_at IS NULL",
            [current.order_id, me.id]
          );
          if (claimed.rowCount === 0) throw new ConflictError("This order is not waiting for pickup");
          claimedNow = true;
        }
        try {
          await orders().changeStatus(current.order_id, "shipped");
        } catch (err) {
          // نتراجع فقط عن حجز سجّلناه في هذا الطلب نفسه.
          if (claimedNow) await query(pool, "UPDATE deliveries SET picked_up_at = NULL WHERE order_id = $1", [current.order_id]);
          throw err;
        }
        res.json(await findDelivery(pool, current.order_id));
      });

      /**
       * "تم التسليم": الطلب delivered، وإن كان الدفع نقداً عند الاستلام فالمندوب حصّل المبلغ،
       * فتصبح حالة الدفع paid برقم مرجعي يذكر اسم المندوب (يظهر للمدير في تفاصيل الطلب).
       *
       * الشروط: أن يكون المندوب قد استلم الطلب فعلاً (picked_up_at)، فلا يُسجَّل نقد على مندوب لم
       * يحمل الطلب أصلاً. وآلة الحالات في الإطار ترفض التسليم قبل الشحن على أي حال.
       *
       * قابل للإعادة: الخطوات ثلاث (الحالة، ثم الدفع، ثم الختم)، وكل واحدة في معاملتها. إن توقف
       * الخادم بعد الأولى، يبقى الطلب "تم التسليم" بلا ختم (cash_collected فارغ)، وضغط المندوب مرة
       * أخرى يكمل الباقي فقط. cash_collected غير الفارغ يعني أن التسليم اكتمل.
       */
      router.post("/courier/deliveries/:orderId/deliver", authenticate, canWork, async (req, res) => {
        const me = await activeStaff(staffRepo(), req, ["courier"]);
        const current = await myDelivery(me, req.params.orderId);
        if (!current.picked_up_at) throw new ConflictError("Pick up the order before delivering it", { status: current.status });
        if (!["shipped", "delivered"].includes(current.status) || current.cash_collected !== null) {
          throw new ConflictError("This delivery is already completed", { status: current.status });
        }
        const order = current.status === "shipped"
          ? await orders().changeStatus(current.order_id, "delivered")
          : await ordersRepo().findById(current.order_id);
        let cash = 0;
        if (cashPaymentMethods.includes(order.paymentMethod) && ["pending", "unpaid"].includes(order.paymentStatus)) {
          await orders().setPaymentStatus(order.id, "paid", `نقداً عبر المندوب: ${me.name}`);
          cash = order.total;
        }
        await query(pool, "UPDATE deliveries SET delivered_at = coalesce(delivered_at, now()), cash_collected = $2 WHERE order_id = $1", [order.id, cash]);
        res.json(await findDelivery(pool, order.id));
      });

      // إبلاغ عن مشكلة: تُحفظ آخر ملاحظة فقط، ويراها المدير في جدول الطلبات وتفاصيل الطلب.
      router.post("/courier/deliveries/:orderId/note", authenticate, canWork, validateBody(noteSchema), async (req, res) => {
        const me = await activeStaff(staffRepo(), req, ["courier"]);
        const current = await myDelivery(me, req.params.orderId);
        // الطول يُفحص بعد حذف المسافات: ملاحظة من مسافات فقط ليست ملاحظة.
        const note = req.body.note.trim();
        if (note.length < 2) throw new ValidationError("Validation failed", [{ field: "note", message: "must be at least 2 characters" }]);
        await query(pool, "UPDATE deliveries SET note = $2, note_at = now() WHERE order_id = $1", [current.order_id, note]);
        res.json(await findDelivery(pool, current.order_id));
      });
    },
  };
}

module.exports = { courierDelivery };
