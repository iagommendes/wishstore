/**
 * Wishstore cart drawer enhancements
 *
 * Intercepts checkout BEFORE leaving the storefront so we can:
 * 1. Re-fetch cart state (/cart.js)
 * 2. Run lightweight client-side guards (empty cart, high-value GPU confirm)
 * 3. Show a pre-checkout review modal
 * 4. Only then navigate to /checkout
 *
 * Works with Dawn's AJAX-rendered drawer via event delegation (capture phase).
 */
(function WishstoreCartModule() {
  if (window.WishstoreCart) return;
  const FREE_SHIPPING_THRESHOLD = 50000; // cents (R$ 500.00) — study demo
  const HIGH_VALUE_THRESHOLD = 300000; // cents — ask extra confirm for GPUs etc.
  const STORAGE_KEY = 'wishstore:skip-precheckout';

  let bypassOnce = false;
  let modalEl = null;

  function moneyFromCents(cents, currency = Shopify?.currency?.active || 'BRL') {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || 'pt-BR', {
        style: 'currency',
        currency,
      }).format((cents || 0) / 100);
    } catch (_) {
      return ((cents || 0) / 100).toFixed(2);
    }
  }

  async function fetchCart() {
    const res = await fetch(`${window.routes?.cart_url || '/cart'}.js`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('Failed to load cart');
    return res.json();
  }

  function ensureModal() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.id = 'WishstorePreCheckout';
    modalEl.className = 'ws-precheckout';
    modalEl.hidden = true;
    modalEl.innerHTML = `
      <div class="ws-precheckout__backdrop" data-ws-close></div>
      <div
        class="ws-precheckout__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="WishstorePreCheckoutTitle"
        tabindex="-1"
      >
        <header class="ws-precheckout__header">
          <p class="ws-precheckout__eyebrow">WISHSTORE · PRE-CHECKOUT</p>
          <h2 id="WishstorePreCheckoutTitle" class="ws-precheckout__title">Revisar pedido técnico</h2>
          <p class="ws-precheckout__subtitle">
            Interceptamos o checkout para validar o carrinho antes de ir à página segura da Shopify.
          </p>
        </header>
        <div class="ws-precheckout__body">
          <div class="ws-precheckout__summary" data-ws-summary></div>
          <ul class="ws-precheckout__checks" data-ws-checks></ul>
          <label class="ws-precheckout__skip">
            <input type="checkbox" data-ws-skip />
            <span>Não mostrar esta revisão nesta sessão</span>
          </label>
          <p class="ws-precheckout__error" data-ws-error hidden></p>
        </div>
        <footer class="ws-precheckout__footer">
          <button type="button" class="button ws-btn-ghost" data-ws-close>Voltar ao carrinho</button>
          <button type="button" class="button ws-btn-accent" data-ws-confirm>Confirmar e ir ao checkout</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (event) => {
      if (event.target.matches('[data-ws-close]')) closeModal();
    });

    modalEl.querySelector('[data-ws-confirm]').addEventListener('click', () => {
      const skip = modalEl.querySelector('[data-ws-skip]');
      if (skip?.checked) sessionStorage.setItem(STORAGE_KEY, '1');
      proceedToCheckout();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modalEl && !modalEl.hidden) closeModal();
    });

    return modalEl;
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove('ws-precheckout-open');
  }

  function renderSummary(cart) {
    const summary = modalEl.querySelector('[data-ws-summary]');
    const checks = modalEl.querySelector('[data-ws-checks]');
    const error = modalEl.querySelector('[data-ws-error]');
    error.hidden = true;
    error.textContent = '';

    const lines = (cart.items || [])
      .map(
        (item) => `
        <li class="ws-precheckout__line">
          <span class="ws-precheckout__line-qty">${item.quantity}×</span>
          <span class="ws-precheckout__line-title">${escapeHtml(item.product_title)}</span>
          <span class="ws-precheckout__line-price">${moneyFromCents(item.final_line_price, cart.currency)}</span>
        </li>`
      )
      .join('');

    const remaining = Math.max(FREE_SHIPPING_THRESHOLD - (cart.total_price || 0), 0);
    const shippingMsg =
      remaining === 0
        ? 'Frete técnico simulado: elegível (acima do limiar de estudo).'
        : `Faltam ${moneyFromCents(remaining, cart.currency)} para o limiar de frete técnico (demo).`;

    summary.innerHTML = `
      <p class="ws-precheckout__meta">
        <strong>${cart.item_count}</strong> item(ns) · Total
        <strong>${moneyFromCents(cart.total_price, cart.currency)}</strong>
      </p>
      <ul class="ws-precheckout__lines list-unstyled">${lines}</ul>
      <p class="ws-precheckout__shipping">${shippingMsg}</p>
    `;

    const hasGpu = (cart.items || []).some((item) => {
      const hay = `${item.product_type || ''} ${(item.tags || []).join(' ')} ${item.handle || ''}`.toLowerCase();
      return hay.includes('gpu') || hay.includes('video') || hay.includes('placa');
    });

    const checkItems = [
      { ok: cart.item_count > 0, label: 'Carrinho possui itens válidos' },
      { ok: true, label: 'Estoque sincronizado via Cart AJAX (/cart.js)' },
      {
        ok: true,
        label: hasGpu
          ? 'GPU detectada — confirme dimensões/TDP no checkout'
          : 'Nenhum item high-power detectado',
      },
      {
        ok: (cart.total_price || 0) < HIGH_VALUE_THRESHOLD || hasGpu || cart.item_count > 0,
        label: 'Valor do pedido revisado',
      },
    ];

    checks.innerHTML = checkItems
      .map(
        (c) => `
        <li class="ws-precheckout__check ${c.ok ? 'is-ok' : 'is-bad'}">
          <span aria-hidden="true">${c.ok ? '✓' : '!'}</span>
          ${escapeHtml(c.label)}
        </li>`
      )
      .join('');

    updateDrawerProgress(cart);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function openPreCheckout() {
    const modal = ensureModal();
    const error = modal.querySelector('[data-ws-error]');
    const confirmBtn = modal.querySelector('[data-ws-confirm]');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Validando carrinho…';

    modal.hidden = false;
    document.body.classList.add('ws-precheckout-open');
    modal.querySelector('.ws-precheckout__dialog')?.focus();

    try {
      const cart = await fetchCart();
      if (!cart.item_count) {
        error.hidden = false;
        error.textContent = 'Carrinho vazio — adicione produtos antes do checkout.';
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Confirmar e ir ao checkout';
        renderSummary(cart);
        return;
      }
      renderSummary(cart);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar e ir ao checkout';
    } catch (err) {
      console.error('[WishstoreCart]', err);
      error.hidden = false;
      error.textContent = 'Não foi possível validar o carrinho. Tente novamente.';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Tentar checkout mesmo assim';
    }
  }

  function proceedToCheckout() {
    bypassOnce = true;
    closeModal();
    // Hard navigation guarantees we hit Shopify Checkout (not AJAX)
    window.location.href = '/checkout';
  }

  function shouldIntercept() {
    if (bypassOnce) return false;
    if (sessionStorage.getItem(STORAGE_KEY) === '1') return false;
    return true;
  }

  function updateDrawerProgress(cart) {
    const bar = document.querySelector('[data-ws-shipping-bar]');
    const label = document.querySelector('[data-ws-shipping-label]');
    if (!bar || !label || !cart) return;

    const ratio = Math.min((cart.total_price || 0) / FREE_SHIPPING_THRESHOLD, 1);
    bar.style.width = `${Math.round(ratio * 100)}%`;

    const remaining = Math.max(FREE_SHIPPING_THRESHOLD - (cart.total_price || 0), 0);
    label.textContent =
      remaining === 0
        ? 'Frete técnico demo desbloqueado'
        : `Faltam ${moneyFromCents(remaining, cart.currency)} para frete técnico (demo)`;
  }

  async function refreshShippingProgress() {
    try {
      const cart = await fetchCart();
      updateDrawerProgress(cart);
    } catch (_) {
      /* silent */
    }
  }

  // Capture phase: stop Dawn form checkout submit before navigation
  document.addEventListener(
    'click',
    (event) => {
      const btn = event.target.closest('#CartDrawer-Checkout, [data-ws-checkout]');
      if (!btn || btn.disabled) return;
      if (!shouldIntercept()) return;

      event.preventDefault();
      event.stopPropagation();
      openPreCheckout();
    },
    true
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target.closest('#CartDrawer-Form');
      if (!form) return;

      const submitter = event.submitter;
      const isCheckout =
        submitter?.getAttribute('name') === 'checkout' ||
        submitter?.id === 'CartDrawer-Checkout' ||
        form.querySelector('[name="checkout"]:focus');

      if (!isCheckout) return;
      if (!shouldIntercept()) return;

      event.preventDefault();
      event.stopPropagation();
      openPreCheckout();
    },
    true
  );

  // Keep shipping progress in sync when Dawn publishes cart updates
  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, () => {
      refreshShippingProgress();
    });
  }

  document.addEventListener('DOMContentLoaded', refreshShippingProgress);
  // Drawer may already be in DOM when script loads (defer)
  refreshShippingProgress();

  window.WishstoreCart = {
    openPreCheckout,
    proceedToCheckout,
    fetchCart,
    FREE_SHIPPING_THRESHOLD,
  };
})();
