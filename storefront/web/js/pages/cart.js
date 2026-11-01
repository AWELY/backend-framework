import { api, getExistingCart, linePath } from "../api.js";
import { mountLayout, esc, money, errorText, toast, refreshCartBadge, icon } from "../ui.js";

/**
 * صفحة السلة: السطور بأسعارها الحالية، وتغيير الكمية، والحذف.
 * السطر يحدده المنتج والشكل معاً (نفس الجراب بلونين = سطران)، فالتعديل يرسل ?variantId=.
 */
mountLayout("cart");
const app = document.getElementById("app");

async function render() {
  const cart = await getExistingCart();
  if (!cart || cart.items.length === 0) {
    app.innerHTML = `<h1 class="page-title">سلة التسوق</h1>
      <div class="panel empty"><span class="empty-icon">${icon("cart", 40)}</span><div class="big">سلتك فارغة</div><p>أضف منتجات من المتجر ثم عُد هنا.</p>
      <a class="btn" href="index.html">تسوّق الآن</a></div>`;
    return;
  }

  const blocked = cart.items.some((i) => !i.available);
  const count = cart.items.reduce((sum, i) => sum + i.quantity, 0);
  app.innerHTML = `
    <h1 class="page-title">سلة التسوق <span class="muted">(${count} قطعة)</span></h1>
    <div class="layout-2">
      <section class="panel">
        ${cart.items.map((i, index) => `
          <div class="cart-line">
            <img src="${esc(i.imageUrl ?? "images/placeholder.svg")}" alt="${esc(i.name)}">
            <div>
              <div class="row">
                <a class="name" href="product.html?id=${encodeURIComponent(i.productId)}">${esc(i.name)}</a>
                <strong>${money(i.lineTotal)}</strong>
              </div>
              ${i.variantTitle ? `<div class="variant-tag">${esc(i.variantTitle)} <span class="muted ltr">${esc(i.sku ?? "")}</span></div>` : ""}
              <div class="muted">${money(i.unitPrice)} للقطعة</div>
              ${i.available ? "" : `<div class="unavailable">هذا المنتج لم يعد متوفراً — احذفه للمتابعة</div>`}
              <div class="row">
                <div class="qty">
                  <button type="button" data-line="${index}" data-to="${i.quantity + 1}" aria-label="زيادة">${icon("plus", 16)}</button>
                  <input type="number" value="${i.quantity}" readonly aria-label="الكمية">
                  <button type="button" data-line="${index}" data-to="${i.quantity - 1}" aria-label="إنقاص">${icon("minus", 16)}</button>
                </div>
                <button class="link-btn" data-line="${index}" data-to="0">${icon("trash", 16)} حذف</button>
              </div>
            </div>
          </div>`).join("")}
      </section>
      <aside class="panel summary">
        <h3>ملخص الطلب</h3>
        <div class="line"><span>عدد القطع</span><span>${count}</span></div>
        <div class="line"><span>المجموع</span><span>${money(cart.total)}</span></div>
        <div class="line muted"><span>التوصيل والكوبون</span><span>في الخطوة التالية</span></div>
        <div class="line total"><span>الإجمالي قبل التوصيل</span><span>${money(cart.total)}</span></div>
        ${blocked ? `<div class="alert error">احذف المنتجات غير المتوفرة أولاً.</div>` : ""}
        <a class="btn btn-lg btn-block ${blocked ? "hidden" : ""}" href="checkout.html">إتمام الطلب</a>
        <a class="btn btn-light btn-block" href="index.html">متابعة التسوق</a>
      </aside>
    </div>`;

  app.querySelectorAll("[data-line]").forEach((b) =>
    b.addEventListener("click", async () => {
      const line = cart.items[Number(b.dataset.line)];
      const quantity = Number(b.dataset.to);
      try {
        const path = linePath(cart.id, line.productId, line.variantId);
        if (quantity <= 0) await api(path, { method: "DELETE" });
        else await api(path, { method: "PUT", body: { quantity } });
        await render();
        refreshCartBadge();
      } catch (err) {
        toast(errorText(err), "error");
      }
    })
  );
}

render().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">تعذّر تحميل السلة</div><p>${esc(errorText(err))}</p></div>`;
});
