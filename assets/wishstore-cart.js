/**
 * Wishstore cart drawer enhancements
 *
 * Intercepts checkout BEFORE leaving the storefront so we can:
 * 1. Re-fetch cart state (/cart.js)
 * 2. Run client-side guards
 * 3. Show a pre-checkout review modal
 * 4. Navigate to the localized checkout URL
 */
(function WishstoreCartModule() {
  if (window.WishstoreCart) return;

  const FREE_SHIPPING_THRESHOLD = 50000; // cents (R$ 500.00) — study demo
  const HIGH_VALUE_THRESHOLD = 300000; // cents
  const STORAGE_KEY = 'wishstore:skip-precheckout';
  const GPU_TYPES = ['placas de video', 'placas de vídeo', 'gpu', 'graphics cards'];

  let bypassOnce = false;
  let modalEl = null;
  let lastTrigger = null;

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

  function checkoutUrl() {
    const root = window.Shopify?.routes?.root || '/';
    return `${root}checkout`;
  }

  function safeSessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeSessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (_) {
      /* private mode / blocked storage */
    }
  }

  async function fetchCart() {
    const cartPath = window.routes?.cart_url || `${window.Shopify?.routes?.root || '/'}cart`;
    const res = await fetch(`${cartPath}.js`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('Failed to load cart');
    return res.json();
  }

  function isGpuItem(item) {
    const type = (item.product_type || '').toLowerCase().trim();
    const handle = (item.handle || '').toLowerCase();
    const title = (item.product_title || item.title || '').toLowerCase();
    if (GPU_TYPES.includes(type)) return true;
    if (handle.includes('voltforce') || handle.includes('novacore') || handle.includes('-gpu')) return true;
    if (/\bgpu\b|placa de v[ií]deo|graphics card/i.test(`${title} ${type}`)) return true;
    return false;
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
            Validamos o carrinho no navegador antes de redirecionar ao checkout Shopify.
          </p>
        </header>
        <div class="ws-precheckout__body">
          <div class="ws-precheckout__summary" data-ws-summary></div>
          <ul class="ws-precheckout__checks" data-ws-checks></ul>
          <label class="ws-precheckout__ack" data-ws-ack-wrap hidden>
            <input type="checkbox" data-ws-ack />
            <span>Confirmo a revisão de itens high-value / GPU neste pedido.</span>
          </label>
          <label class="ws-precheckout__skip">
            <input type="checkbox" data-ws-skip />
            <span>Não mostrar esta revisão nesta sessão</span>
          </label>
          <p class="ws-precheckout__error" data-ws-error hidden></p>
        </div>
        <footer class="ws-precheckout__footer">
          <button type="button" class="button button--secondary" data-ws-close>Voltar ao carrinho</button>
          <button type="button" class="button" data-ws-confirm>Confirmar e ir ao checkout</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (event) => {
      if (event.target.matches('[data-ws-close]')) closeModal();
    });

    modalEl.querySelector('[data-ws-ack]')?.addEventListener('change', syncConfirmEnabled);
    modalEl.querySelector('[data-ws-confirm]').addEventListener('click', () => {
      const skip = modalEl.querySelector('[data-ws-skip]');
      if (skip?.checked) safeSessionSet(STORAGE_KEY, '1');
      proceedToCheckout();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modalEl && !modalEl.hidden) closeModal();
    });

    return modalEl;
  }

  function syncConfirmEnabled() {
    if (!modalEl) return;
    const confirmBtn = modalEl.querySelector('[data-ws-confirm]');
    const ackWrap = modalEl.querySelector('[data-ws-ack-wrap]');
    const ack = modalEl.querySelector('[data-ws-ack]');
    if (ackWrap?.hidden) {
      confirmBtn.disabled = false;
      return;
    }
    confirmBtn.disabled = !ack?.checked;
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove('ws-precheckout-open');
    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      lastTrigger.focus();
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSummary(cart) {
    const summary = modalEl.querySelector('[data-ws-summary]');
    const checks = modalEl.querySelector('[data-ws-checks]');
    const error = modalEl.querySelector('[data-ws-error]');
    const ackWrap = modalEl.querySelector('[data-ws-ack-wrap]');
    const ack = modalEl.querySelector('[data-ws-ack]');
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

    const hasGpu = (cart.items || []).some(isGpuItem);
    const isHighValue = (cart.total_price || 0) >= HIGH_VALUE_THRESHOLD;
    const needsAck = hasGpu || isHighValue;

    const checkItems = [
      { ok: cart.item_count > 0, label: 'Carrinho possui itens válidos' },
      { ok: true, info: true, label: 'Estado sincronizado via Cart AJAX (/cart.js)' },
      {
        ok: !hasGpu || needsAck,
        label: hasGpu
          ? 'GPU detectada — confirme TDP/dimensões no ack abaixo'
          : 'Nenhum item GPU detectado via product_type/handle',
      },
      {
        ok: !isHighValue || needsAck,
        label: isHighValue
          ? `Pedido high-value (≥ ${moneyFromCents(HIGH_VALUE_THRESHOLD, cart.currency)})`
          : 'Valor do pedido abaixo do limiar high-value',
      },
    ];

    checks.innerHTML = checkItems
      .map(
        (c) => `
        <li class="ws-precheckout__check ${c.ok ? 'is-ok' : 'is-bad'}${c.info ? ' is-info' : ''}">
          <span aria-hidden="true">${c.ok ? '✓' : '!'}</span>
          ${escapeHtml(c.label)}
        </li>`
      )
      .join('');

    ackWrap.hidden = !needsAck;
    if (!needsAck && ack) ack.checked = false;
    syncConfirmEnabled();
    updateDrawerProgress(cart);
  }

  async function openPreCheckout(trigger) {
    lastTrigger = trigger || document.getElementById('CartDrawer-Checkout');
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
    window.location.href = checkoutUrl();
  }

  function shouldIntercept() {
    if (bypassOnce) return false;
    if (safeSessionGet(STORAGE_KEY) === '1') return false;
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

  document.addEventListener(
    'click',
    (event) => {
      const btn = event.target.closest('#CartDrawer-Checkout, [data-ws-checkout]');
      if (!btn || btn.disabled) return;
      if (!shouldIntercept()) return;

      event.preventDefault();
      openPreCheckout(btn);
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
        submitter?.getAttribute('name') === 'checkout' || submitter?.id === 'CartDrawer-Checkout';

      if (!isCheckout) return;
      if (!shouldIntercept()) return;

      event.preventDefault();
      openPreCheckout(submitter || document.getElementById('CartDrawer-Checkout'));
    },
    true
  );

  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, () => {
      refreshShippingProgress();
    });
  }

  document.addEventListener('DOMContentLoaded', refreshShippingProgress);
  if (document.readyState !== 'loading') refreshShippingProgress();

  window.WishstoreCart = {
    openPreCheckout,
    proceedToCheckout,
    fetchCart,
    checkoutUrl,
    FREE_SHIPPING_THRESHOLD,
    HIGH_VALUE_THRESHOLD,
  };
})();
