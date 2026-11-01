// صفحة السلة (cart.html): سطور السلة، وتغيير الكميات، والحذف، وملخص الطلب.
// كل الأسعار والمجاميع تأتي من الـ API كما هي: الموقع لا يحسب أي سعر بنفسه، لأن المتصفح
// بيد المستخدم ويمكن التلاعب به، والخادم هو المرجع.
import { api, getExistingCart } from "../api.js";
import { mountLayout, esc, money, errorText, toast, refreshCartBadge, icon } from "../ui.js";

mountLayout("cart");
const app = document.getElementById("app");

/** يرسم السلة. يُستدعى أول مرة، ثم بعد كل تعديل ليعرض ما رد به الخادم. */
async function render() {
  // getExistingCart لا تنشئ سلة: زيارة صفحة السلة لا تنشئ سلة فارغة.
  const cart = await getExistingCart();
  if (!cart || cart.items.length === 0) {
    app.innerHTML = `<h1 class="page-title">سلة التسوق</h1>
      <div class="panel empty"><span class="empty-icon">${icon("cart", 40)}</span><div class="big">سلتك فارغة</div><p>أضف منتجات من المتجر ثم عُد هنا.</p>
      <a class="btn" href="index.html">تسوّق الآن</a></div>`;
    return;
  }

  // منتج أُخفي بعد إضافته (available = false) يمنع إتمام الطلب حتى يُحذف، لأن الخادم سيرفضه.
  const blocked = cart.items.some((i) => !i.available);
  const count = cart.items.reduce((sum, i) => sum + i.quantity, 0);
  // أزرار + و - تحمل الكمية الجديدة جاهزة في data-to، و data-set فيه رقم المنتج.
  app.innerHTML = `
    <h1 class="page-title">سلة التسوق <span class="muted">(${count} قطعة)</span></h1>
    <div class="layout-2">
      <section class="panel">
        ${cart.items.map((i) => `
          <div class="cart-line">
            <img src="${esc(i.imageUrl ?? "images/placeholder.svg")}" alt="${esc(i.name)}">
            <div>
              <div class="row">
                <a class="name" href="product.html?id=${encodeURIComponent(i.productId)}">${esc(i.name)}</a>
                <strong>${money(i.lineTotal)}</strong>
              </div>
              <div class="muted">${money(i.unitPrice)} للقطعة</div>
              ${i.available ? "" : `<div class="unavailable">هذا المنتج لم يعد متوفراً — احذفه للمتابعة</div>`}
              <div class="row">
                <div class="qty">
                  <button type="button" data-set="${esc(i.productId)}" data-to="${i.quantity + 1}" aria-label="زيادة">${icon("plus", 16)}</button>
                  <input type="number" value="${i.quantity}" readonly aria-label="الكمية">
                  <button type="button" data-set="${esc(i.productId)}" data-to="${i.quantity - 1}" aria-label="إنقاص">${icon("minus", 16)}</button>
                </div>
                <button class="link-btn" data-remove="${esc(i.productId)}">${icon("trash", 16)} حذف</button>
              </div>
            </div>
          </div>`).join("")}
      </section>
      <aside class="panel summary">
        <h3>ملخص الطلب</h3>
        <div class="line"><span>عدد القطع</span><span>${count}</span></div>
        <div class="line"><span>المجموع</span><span>${money(cart.total)}</span></div>
        <div class="line muted"><span>التوصيل</span><span>يُحسب حسب المدينة</span></div>
        <div class="line total"><span>الإجمالي قبل التوصيل</span><span>${money(cart.total)}</span></div>
        <p class="summary-note">${icon("cash", 16)} الدفع نقداً عند الاستلام</p>
        ${blocked ? `<div class="alert error">احذف المنتجات غير المتوفرة أولاً.</div>` : ""}
        <a class="btn btn-lg btn-block ${blocked ? "hidden" : ""}" href="checkout.html">إتمام الطلب</a>
        <a class="btn btn-light btn-block" href="index.html">متابعة التسوق</a>
      </aside>
    </div>`;

  /**
   * يغيّر كمية سطر: 0 أو أقل تحذفه (DELETE)، وغير ذلك يضبطه (PUT). ثم نعيد رسم السلة
   * من رد الخادم. إن رفض الخادم (مثلاً المخزون لا يكفي)، تظهر رسالة ولا يتغير شيء.
   */
  const update = async (productId, quantity) => {
    try {
      if (quantity <= 0) await api(`/carts/${cart.id}/items/${encodeURIComponent(productId)}`, { method: "DELETE" });
      else await api(`/carts/${cart.id}/items/${encodeURIComponent(productId)}`, { method: "PUT", body: { quantity } });
      await render();
      refreshCartBadge();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };
  app.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => update(b.dataset.set, Number(b.dataset.to))));
  app.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => update(b.dataset.remove, 0)));
}

render().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل السلة</div><p>${esc(errorText(err))}</p></div>`;
});
