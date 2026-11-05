const { requirePermission } = require("commerce-framework");
const { query } = require("./shared");
const { STAFF_REPOSITORY, activeAdminGuard } = require("./staff");

/**
 * إضافة "التقارير": الأرقام التي تعرضها الصفحة الرئيسية في لوحة التحكم، محسوبة في القاعدة
 * باستعلامات تجميع (SUM و COUNT و GROUP BY)، لا في المتصفح.
 *
 * لماذا في الخادم؟ لو حسبتها اللوحة بنفسها، لاحتاجت تحميل كل الطلبات أولاً (الإطار يعطي 100 طلب
 * كحد أقصى في الصفحة الواحدة). استعلام التجميع يرجع الأرقام النهائية فقط، مهما كثرت الطلبات.
 *
 * المسارات (كلها reports:read أو customers:read، أي المدير):
 *   GET /admin/summary          المبيعات (اليوم والشهر والكل)، والطلبات حسب الحالة، ومبيعات آخر
 *                               14 يوماً، والأكثر مبيعاً، والمنتجات التي قارب مخزونها على النفاد
 *   GET /admin/stock            كمية كل المنتجات في استعلام واحد (لجدول المنتجات في اللوحة)
 *   GET /admin/customer-stats   لكل زبون: عدد طلباته ومجموع مشترياته وآخر طلب
 *
 * ملاحظة عن الإطار: GET /inventory/:productId يعطي منتجاً واحداً فقط، فجدول فيه 16 منتجاً كان
 * سيحتاج 16 طلباً. /admin/stock يسد هذه الفجوة للمتجر، وهي ميزة تستحق أن تُضاف للإطار نفسه.
 *
 * المبيعات لا تحسب الطلبات الملغاة. والمبالغ بالدرهم (1 دينار = 1000).
 * timeZone: "اليوم" و"هذا الشهر" بتوقيت المتجر، لا بتوقيت الخادم (قد يكون في بلد آخر).
 */
function storeReports({ timeZone = "Africa/Tripoli", lowStockThreshold = 3 } = {}) {
  return {
    name: "store-reports",
    setup({ router, container, pool, accessControl, authenticate }) {
      const canRead = requirePermission(accessControl, "reports:read");
      const canReadCustomers = requirePermission(accessControl, "customers:read");
      const adminActive = activeAdminGuard(() => container.resolve(STAFF_REPOSITORY));

      router.get("/admin/summary", authenticate, canRead, adminActive, async (_req, res) => {
        // خمسة استعلامات مستقلة، تُرسل معاً (Promise.all) فتعمل على اتصالات متوازية من المجموعة.
        //
        // $1 هو التوقيت. "(created_at AT TIME ZONE $1)::date" تعني: تاريخ الطلب بتوقيت ليبيا.
        // FILTER (WHERE ...) تجعل نفس الاستعلام يحسب "اليوم" و"الشهر" و"الكل" في مرور واحد.
        const [totals, statuses, daily, top, low] = await Promise.all([
          query(
            pool,
            `SELECT
               count(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)::int AS today_orders,
               coalesce(sum(total) FILTER (WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0)::bigint AS today_revenue,
               count(*) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1))::int AS month_orders,
               coalesce(sum(total) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1)), 0)::bigint AS month_revenue,
               count(*)::int AS all_orders,
               coalesce(sum(total), 0)::bigint AS all_revenue,
               coalesce(sum(total) FILTER (WHERE payment_status IN ('pending', 'unpaid')), 0)::bigint AS uncollected,
               (SELECT count(*) FROM customers)::int AS customers
             FROM orders WHERE status <> 'cancelled'`,
            [timeZone]
          ),
          query(pool, "SELECT status, count(*)::int AS count FROM orders GROUP BY status"),
          // generate_series يولّد الأيام الأربعة عشر كلها، و LEFT JOIN يربط طلبات كل يوم به،
          // فاليوم الذي بلا طلبات يظهر بصفر بدل أن يختفي من الرسم البياني.
          query(
            pool,
            `SELECT to_char(day, 'YYYY-MM-DD') AS day, count(o.id)::int AS orders, coalesce(sum(o.total), 0)::bigint AS revenue
               FROM generate_series((now() AT TIME ZONE $1)::date - 13, (now() AT TIME ZONE $1)::date, interval '1 day') AS day
               LEFT JOIN orders o ON (o.created_at AT TIME ZONE $1)::date = day::date AND o.status <> 'cancelled'
              GROUP BY day ORDER BY day`,
            [timeZone]
          ),
          // الأكثر مبيعاً بالكمية، من سطور الطلبات (الاسم المنسوخ وقت الشراء). المنتج المحذوف
          // product_id فيه NULL، فنجمّع المحذوفات بأسمائها (CASE) لا معاً في صف واحد.
          query(
            pool,
            `SELECT oi.product_id, max(oi.product_name) AS name, sum(oi.quantity)::int AS quantity, sum(oi.line_total)::bigint AS revenue
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE o.status <> 'cancelled'
              GROUP BY oi.product_id, CASE WHEN oi.product_id IS NULL THEN oi.product_name END
              ORDER BY quantity DESC, revenue DESC LIMIT 5`
          ),
          // المنتجات المعروضة التي بقي منها lowStockThreshold قطع أو أقل (المنتج بلا صف مخزون كميته 0).
          query(
            pool,
            `SELECT p.id, p.name, p.image_url, coalesce(i.quantity, 0)::int AS quantity
               FROM products p LEFT JOIN inventory i ON i.product_id = p.id
              WHERE p.is_active AND coalesce(i.quantity, 0) <= $1
              ORDER BY quantity, p.name LIMIT 10`,
            [lowStockThreshold]
          ),
        ]);

        // bigint يصل من مكتبة pg نصاً (قد يتجاوز حدود أرقام JavaScript)، فنحوّله بـ Number:
        // مبالغ متجر صغير أبعد ما تكون عن ذلك الحد.
        const t = totals.rows[0];
        res.json({
          today: { orders: t.today_orders, revenue: Number(t.today_revenue) },
          month: { orders: t.month_orders, revenue: Number(t.month_revenue) },
          allTime: { orders: t.all_orders, revenue: Number(t.all_revenue), customers: t.customers },
          uncollected: Number(t.uncollected),
          byStatus: Object.fromEntries(statuses.rows.map((r) => [r.status, r.count])),
          daily: daily.rows.map((r) => ({ day: r.day, orders: r.orders, revenue: Number(r.revenue) })),
          topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, quantity: r.quantity, revenue: Number(r.revenue) })),
          lowStock: low.rows.map((r) => ({ productId: r.id, name: r.name, imageUrl: r.image_url, quantity: r.quantity })),
        });
      });

      // كمية كل منتج (ومنها المخفية) في استعلام واحد.
      router.get("/admin/stock", authenticate, canRead, adminActive, async (_req, res) => {
        const { rows } = await query(
          pool,
          "SELECT p.id, coalesce(i.quantity, 0)::int AS quantity FROM products p LEFT JOIN inventory i ON i.product_id = p.id"
        );
        res.json(rows.map((r) => ({ productId: r.id, quantity: r.quantity })));
      });

      // إحصاءات الزبائن المسجلين. قائمة الزبائن نفسها من الإطار (GET /customers)، واللوحة تدمج الاثنين.
      router.get("/admin/customer-stats", authenticate, canReadCustomers, adminActive, async (_req, res) => {
        const { rows } = await query(
          pool,
          `SELECT customer_id, count(*)::int AS orders,
                  coalesce(sum(total) FILTER (WHERE status <> 'cancelled'), 0)::bigint AS spent,
                  max(created_at) AS last_order_at
             FROM orders WHERE customer_id IS NOT NULL GROUP BY customer_id`
        );
        res.json(rows.map((r) => ({ customerId: r.customer_id, orders: r.orders, spent: Number(r.spent), lastOrderAt: r.last_order_at })));
      });
    },
  };
}

module.exports = { storeReports };
