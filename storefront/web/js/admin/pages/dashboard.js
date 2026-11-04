// الصفحة الرئيسية للوحة التحكم (admin/index.html): ما يحتاج المدير أن يعرفه عند فتح اللوحة.
//   - أرقام اليوم والشهر، والطلبات الجديدة، والمبالغ التي لم تُحصَّل.
//   - رسم المبيعات اليومية لآخر 14 يوماً، والطلبات حسب الحالة.
//   - آخر الطلبات، والمندوبون، والمنتجات التي قارب مخزونها على النفاد، والأكثر مبيعاً.
// الأرقام كلها محسوبة في الخادم (إضافة التقارير: GET /admin/summary)، لا هنا.
import { requireAdmin, mountAdmin, staffApi, esc, icon, money, errorText, showLoadError, statusChip, shortId, timeAgo, STATUS, PLACEHOLDER } from "../common.js";

const session = requireAdmin();
if (session) {
  const content = mountAdmin(session, {
    active: "dashboard",
    title: "الرئيسية",
    actions: `<a class="btn btn-sm btn-outline" href="orders.html?status=pending">${icon("receipt", 18)} الطلبات الجديدة</a>`,
  });
  load(content).catch((err) => showLoadError(content, errorText(err)));
}

async function load(content) {
  // ثلاثة طلبات متوازية: التقارير (إضافة)، وآخر 8 طلبات (مسار الإطار)، وملخص المندوبين (إضافة).
  const [summary, recent, couriers] = await Promise.all([
    staffApi("/admin/summary"),
    staffApi("/orders?limit=8"),
    staffApi("/deliveries/couriers"),
  ]);
  const pending = summary.byStatus.pending ?? 0;

  content.innerHTML = `
    <section class="kpis" aria-label="ملخص">
      <div class="kpi"><span class="label">مبيعات اليوم</span><span class="value">${money(summary.today.revenue)}</span><span class="sub">${summary.today.orders} طلب</span></div>
      <div class="kpi"><span class="label">مبيعات هذا الشهر</span><span class="value">${money(summary.month.revenue)}</span><span class="sub">${summary.month.orders} طلب</span></div>
      <a class="kpi ${pending ? "attention" : ""}" href="orders.html?status=pending"><span class="label">طلبات جديدة</span><span class="value">${pending}</span><span class="sub">${pending ? "بانتظار تأكيدك" : "لا شيء ينتظر"}</span></a>
      <div class="kpi"><span class="label">مبالغ لم تُحصَّل بعد</span><span class="value">${money(summary.uncollected)}</span><span class="sub">دفع عند الاستلام، قبل التسليم</span></div>
      <a class="kpi" href="customers.html"><span class="label">الزبائن المسجلون</span><span class="value">${summary.allTime.customers}</span><span class="sub">${summary.allTime.orders} طلب منذ البداية</span></a>
    </section>

    <div class="cols">
      <section class="box">
        <div class="box-head"><h2>المبيعات اليومية، آخر 14 يوماً</h2><span class="muted">بالدينار، دون الطلبات الملغاة</span></div>
        <div class="box-body">${salesChart(summary.daily)}</div>
      </section>
      <section class="box">
        <div class="box-head"><h2>الطلبات حسب الحالة</h2><a href="orders.html">كل الطلبات</a></div>
        <ul class="rows">${Object.keys(STATUS).map((s) => `
          <li><a class="grow" href="orders.html?status=${s}">${statusChip(s)}</a><span class="end">${summary.byStatus[s] ?? 0}</span></li>`).join("")}
        </ul>
      </section>
    </div>

    <div class="cols">
      <section class="box">
        <div class="box-head"><h2>آخر الطلبات</h2><a href="orders.html">عرض الكل</a></div>
        ${recent.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>الطلب</th><th>الزبون</th><th>المبلغ</th><th>الحالة</th><th>الوقت</th></tr></thead>
          <tbody>${recent.map((o) => `
            <tr>
              <td><a class="row-link n" href="order.html?id=${encodeURIComponent(o.id)}">${esc(shortId(o.id))}</a></td>
              <td>${esc(o.contactName)}<span class="sub">${esc(o.shippingCity ?? "استلام من المحل")}</span></td>
              <td class="n">${money(o.total)}</td>
              <td>${statusChip(o.status)}</td>
              <td class="muted">${esc(timeAgo(o.createdAt))}</td>
            </tr>`).join("")}
          </tbody></table></div>` : `<div class="empty"><div class="big">لا طلبات بعد</div><p>عندما يطلب زبون من المتجر، يظهر طلبه هنا.</p></div>`}
      </section>

      <div class="stack">
        <section class="box">
          <div class="box-head"><h2>المندوبون اليوم</h2><a href="staff.html">إدارة</a></div>
          ${couriers.length ? `<ul class="rows">${couriers.filter((c) => c.isActive).map((c) => `
            <li><span class="grow"><b>${esc(c.name)}</b><span>معه ${c.active} طلب، سلّم اليوم ${c.deliveredToday}</span></span>
              <span class="end">${money(c.cashToday)}</span></li>`).join("")}</ul>`
            : `<div class="box-body muted">لا يوجد مندوبون. <a class="row-link" href="staff.html">أضف مندوباً</a></div>`}
        </section>
        <section class="box">
          <div class="box-head"><h2>قارب على النفاد</h2><a href="products.html">المنتجات</a></div>
          ${summary.lowStock.length ? `<ul class="rows">${summary.lowStock.map((p) => `
            <li><img src="${esc(p.imageUrl ?? PLACEHOLDER)}" alt=""><a class="grow" href="product.html?id=${encodeURIComponent(p.productId)}"><b>${esc(p.name)}</b></a>
              ${p.quantity === 0 ? `<span class="status cancelled">نفد</span>` : `<span class="status pending">باقي ${p.quantity}</span>`}</li>`).join("")}</ul>`
            : `<div class="box-body muted">كل المنتجات متوفرة بكميات جيدة.</div>`}
        </section>
        <section class="box">
          <div class="box-head"><h2>الأكثر مبيعاً</h2></div>
          ${summary.topProducts.length ? `<ul class="rows">${summary.topProducts.map((p) => `
            <li><span class="grow"><b>${esc(p.name)}</b><span>${p.quantity} قطعة</span></span><span class="end">${money(p.revenue)}</span></li>`).join("")}</ul>`
            : `<div class="box-body muted">تظهر هنا المنتجات بعد أول المبيعات.</div>`}
        </section>
      </div>
    </div>`;

  bindChart(content.querySelector(".chart"), summary.daily);
}

/**
 * رسم أعمدة للمبيعات اليومية، بـ SVG مكتوب يدوياً (بلا مكتبة رسوم).
 *
 * قواعد الرسم: سلسلة واحدة فلا مفتاح ألوان (العنوان يسميها). العمود بعرض أقصى 24px، وزاوية 4px
 * في طرفه العلوي فقط، ويبدأ من خط أساس واحد. قيمة واحدة فقط مكتوبة على الرسم (أعلى يوم)،
 * والباقي في التلميح عند المرور، وفي "عرض كجدول" لمن لا يستخدم الفأرة أو يستخدم قارئ الشاشة.
 *
 * الاتجاه: الصفحة عربية من اليمين، فالزمن يسير من اليمين (الأقدم) إلى اليسار (اليوم)، ومحور
 * القيم على اليمين. هذا ما توصي به أدلة التصميم ثنائي الاتجاه للرسوم الزمنية.
 */
function salesChart(daily) {
  const W = 640;
  const H = 230;
  const pad = { top: 22, right: 52, bottom: 30, left: 8 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const values = daily.map((d) => d.revenue / 1000);
  const max = Math.max(...values);

  // أعلى المحور: رقم "مستدير" أكبر من أعلى قيمة (مثل 250 أو 500)، مقسوم على 4 خطوط.
  const step = niceStep(max / 4 || 25);
  const top = step * 4;
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / daily.length;
  const barW = Math.min(24, band * 0.6);
  // اليوم الأول (الأقدم) في أقصى اليمين: نعكس الترتيب عند حساب موضع كل عمود.
  const x = (i) => pad.left + (daily.length - 1 - i) * band + (band - barW) / 2;
  const maxIndex = values.lastIndexOf(max);

  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = step * k;
    return `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis-text" x="${W - pad.right + 8}" y="${y(v) + 4}" text-anchor="start">${v.toLocaleString("en-US")}</text>`;
  }).join("");

  const bars = daily.map((d, i) => {
    const v = values[i];
    const bx = x(i);
    const by = y(v);
    const h = pad.top + plotH - by;
    // العمود: مستطيل زاويتاه العلويتان مستديرتان (4px) والسفليتان حادتان عند خط الأساس.
    const r = Math.min(4, h, barW / 2);
    const path = h <= 0 ? "" : `M${bx},${pad.top + plotH} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${pad.top + plotH} Z`;
    const label = `${dayLabel(d.day, true)}: ${money(d.revenue)}، ${d.orders} طلب`;
    // مساحة التفاعل أكبر من العمود (عرض اليوم كاملاً وارتفاع الرسم كله)، فيسهل الوقوف عليها.
    // tabindex="0": يصلها مستخدم لوحة المفاتيح بزر Tab، ويظهر نفس التلميح.
    return `<rect class="hit" x="${pad.left + (daily.length - 1 - i) * band}" y="${pad.top}" width="${band}" height="${plotH}" tabindex="0"
        role="img" aria-label="${esc(label)}" data-i="${i}"/>
      <path class="bar" d="${path}"/>
      ${i === maxIndex && max > 0 ? `<text class="axis-text" x="${bx + barW / 2}" y="${by - 6}" text-anchor="middle">${v.toLocaleString("en-US")}</text>` : ""}
      ${i % 2 === (daily.length - 1) % 2 ? `<text class="axis-text" x="${bx + barW / 2}" y="${H - 8}" text-anchor="middle">${i === daily.length - 1 ? "اليوم" : dayLabel(d.day)}</text>` : ""}`;
  }).join("");

  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="المبيعات اليومية لآخر 14 يوماً">${grid}${bars}</svg>
      <div class="chart-tip hidden" role="status"></div>
      <details class="chart-table"><summary>عرض كجدول</summary>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>اليوم</th><th>الطلبات</th><th>المبيعات</th></tr></thead>
          <tbody>${daily.map((d) => `<tr><td>${esc(dayLabel(d.day, true))}</td><td class="n">${d.orders}</td><td class="n">${money(d.revenue)}</td></tr>`).join("")}</tbody>
        </table></div>
      </details>
    </div>`;
}

/** أقرب رقم "مستدير" (1 أو 2 أو 2.5 أو 5 مضروباً في قوة للعشرة) أكبر من القيمة أو يساويها. */
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
}

/** "2026-11-04" تصبح "4/11"، أو مع long: "الأربعاء 4 نوفمبر". */
function dayLabel(iso, long = false) {
  const [yy, mm, dd] = iso.split("-").map(Number);
  if (!long) return `${dd}/${mm}`;
  return new Date(yy, mm - 1, dd).toLocaleDateString("ar-LY", { weekday: "long", day: "numeric", month: "long" });
}

/**
 * التلميح: عند المرور على يوم أو الوصول إليه بلوحة المفاتيح، يظهر فوقه المبلغ (بخط عريض أولاً)
 * ثم اليوم وعدد الطلبات. نكتب النص بـ textContent لا innerHTML.
 */
function bindChart(chart, daily) {
  if (!chart) return;
  const tip = chart.querySelector(".chart-tip");
  const show = (hit) => {
    const d = daily[Number(hit.dataset.i)];
    tip.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = money(d.revenue);
    tip.append(strong, `${dayLabel(d.day, true)}، ${d.orders} طلب`);
    tip.classList.remove("hidden");
    // موضع التلميح: فوق منتصف اليوم، بتحويل إحداثيات الرسم إلى بكسلات داخل .chart. ونحصره
    // داخل عرض الرسم، فلا يخرج عن الشاشة عند أول يوم أو آخر يوم.
    // (تغيير style من السكربت عبر CSSOM مسموح في سياسة CSP؛ الممنوع هو خاصية style في HTML.)
    const box = hit.getBoundingClientRect();
    const host = chart.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const center = Math.min(host.width - half, Math.max(half, box.left - host.left + box.width / 2));
    tip.style.left = `${center}px`;
    tip.style.top = `${box.top - host.top}px`;
  };
  const hide = () => tip.classList.add("hidden");
  chart.querySelectorAll(".hit").forEach((hit) => {
    hit.addEventListener("pointerenter", () => show(hit));
    hit.addEventListener("focus", () => show(hit));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
  });
}
