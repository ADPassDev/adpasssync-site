// Customer dashboard. Loads /api/auth/me to confirm session, then
// /api/portal/dashboard for license + download history. Renders, then
// wires up the purchase form and the logout button.
(function () {
  'use strict';

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const loading = document.getElementById('loading');
  const content = document.getElementById('content');
  const alertBox = document.getElementById('alert');

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('purchase-form').addEventListener('submit', submitPurchase);
  document.getElementById('profile-form').addEventListener('submit', submitProfile);
  document.getElementById('register-form').addEventListener('submit', submitRegister);
  document.getElementById('buy-form').addEventListener('submit', startCheckout);
  document.getElementById('buy-users').addEventListener('input', showBuyTotal);
  document.getElementById('users-form').addEventListener('submit', previewUsers);
  document.getElementById('users-confirm-btn').addEventListener('click', confirmUsers);
  document.getElementById('users-cancel-btn').addEventListener('click', function () {
    document.getElementById('users-confirm').classList.add('hidden');
  });
  document.getElementById('portal-btn').addEventListener('click', openBillingPortal);

  // Must match the Paddle price (PADDLE_PRICE_ID): $5 per user per year.
  // Paddle's checkout shows the final amount, with any tax.
  const UNIT_PRICE_USD = 5;
  let billing = null;
  let pendingUsers = null;

  init().catch(function (e) {
    console.error(e);
    showAlert('error', 'Could not load your portal. Please refresh.');
  });

  async function init() {
    const me = await fetchJson('/api/auth/me');
    if (!me.authenticated) { location.href = '/portal/'; return; }
    if (me.is_admin) {
      // Drop admins on their dashboard but keep the option to view as customer.
      // The admin link is unobtrusive; nothing else changes here.
      const meta = document.querySelector('.nav-meta');
      if (meta) {
        const a = document.createElement('a');
        a.href = '/portal/admin.html';
        a.textContent = 'Admin';
        a.className = 'muted';
        a.style.marginRight = '0.5rem';
        meta.insertBefore(a, meta.firstChild);
      }
    }
    document.getElementById('user-email').textContent = me.customer.email;

    const results = await Promise.all([fetchJson('/api/portal/dashboard'), fetchJson('/api/portal/billing')]);
    renderDashboard(results[0]);
    renderBilling(results[1]);

    loading.classList.add('hidden');
    content.classList.remove('hidden');
  }

  // ---- Plan and billing (Paddle) ----

  function renderBilling(b) {
    billing = b;
    const sub = b.subscription;
    const plan = document.getElementById('plan-block');
    const show = function (id, on) { document.getElementById(id).classList.toggle('hidden', !on); };

    let html;
    if (sub && sub.live) {
      const yearly = money(sub.quantity * UNIT_PRICE_USD);
      html = '<p><span class="badge professional">professional</span> ' +
        escapeText(String(sub.quantity)) + ' active AD users, ' + escapeText(yearly) + ' per year.</p>';
      if (sub.status === 'past_due') {
        html += '<div class="alert error" style="margin-top:1rem">Your last renewal payment didn\'t go through. ' +
          'Update your payment method under Manage billing' +
          (sub.paid_through ? '; your license runs until ' + escapeText(day(sub.paid_through)) : '') + '.</div>';
      } else if (sub.cancel_at) {
        html += '<p class="muted" style="margin-top:0.5rem">Cancelled: it won\'t renew. Your paid term runs until ' +
          escapeText(day(sub.cancel_at)) + '.</p>';
      } else if (sub.next_billed_at) {
        html += '<p class="muted" style="margin-top:0.5rem">Renews automatically on ' + escapeText(day(sub.next_billed_at)) + '.</p>';
      }
    } else if (sub && sub.refunded_at) {
      html = '<p>Free: up to 50 active AD users. Your Professional subscription was refunded on ' +
        escapeText(day(sub.refunded_at)) + '.</p>';
    } else if (sub && sub.paid_through && sub.paid_through * 1000 > Date.now()) {
      html = '<p><span class="badge professional">professional</span> ' + escapeText(String(sub.quantity)) +
        ' active AD users until ' + escapeText(day(sub.paid_through)) + '. Your subscription has ended and won\'t renew; ' +
        'subscribing again starts a new yearly term today.</p>';
    } else {
      html = '<p>Free: up to 50 active AD users.</p>';
    }
    plan.innerHTML = html;

    const live = !!(sub && sub.live);
    show('buy-form', b.enabled && !live);
    // Paddle can't restart a cancelled subscription: a returning customer
    // starts a new one, and a new yearly term, from today.
    document.getElementById('buy-btn').textContent = sub ? 'Subscribe again' : 'Upgrade';
    show('manage-block', b.enabled && live);
    show('purchase-form', !b.enabled);
    if (live) document.getElementById('users-new').value = String(sub.quantity);
    // A past_due subscription can't change users until the payment is sorted.
    document.getElementById('users-form').classList.toggle('hidden', !(sub && sub.status === 'active'));
    showBuyTotal();
  }

  function showBuyTotal() {
    const n = Number(document.getElementById('buy-users').value);
    document.getElementById('buy-total').textContent = Number.isInteger(n) && n >= 51
      ? n + ' users × $' + UNIT_PRICE_USD + ' = ' + money(n * UNIT_PRICE_USD) + ' per year, before any tax.'
      : 'Enter at least 51 users. Up to 50 are free.';
  }

  async function startCheckout(e) {
    e.preventDefault();
    const btn = document.getElementById('buy-btn');
    btn.disabled = true;
    btn.textContent = 'Opening checkout…';
    try {
      const res = await fetch('/api/portal/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: Number(document.getElementById('buy-users').value) }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', data.error === 'invalid_users'
          ? 'Enter a whole number of users from 51 to 100,000.'
          : data.error === 'already_subscribed'
            ? 'You already have a subscription. Change its users below instead.'
            : 'Checkout is unavailable right now. Please try again shortly.');
        return;
      }
      const paddle = await loadPaddle();
      paddle.Checkout.open({ transactionId: data.transaction_id, settings: { displayMode: 'overlay', locale: 'en' } });
    } catch (err) {
      console.error(err);
      showAlert('error', 'Could not open checkout. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = billing && billing.subscription ? 'Subscribe again' : 'Upgrade';
    }
  }

  // Paddle.js is loaded only when someone starts a checkout.
  function loadPaddle() {
    if (window.Paddle && window.Paddle.Initialized) return Promise.resolve(window.Paddle);
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload = function () {
        if (billing.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({ token: billing.client_token, eventCallback: onPaddleEvent });
        resolve(window.Paddle);
      };
      s.onerror = function () { reject(new Error('Paddle.js failed to load')); };
      document.head.appendChild(s);
    });
  }

  function onPaddleEvent(ev) {
    if (ev && ev.name === 'checkout.completed') {
      showAlert('success', 'Payment received. Your license is being updated; this takes a few seconds.');
      waitForBilling(function (b) { return !!(b.subscription && b.subscription.live); });
    }
  }

  async function previewUsers(e) {
    e.preventDefault();
    const users = Number(document.getElementById('users-new').value);
    const btn = document.getElementById('users-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/portal/billing/users/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: users }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', data.error === 'no_change' ? 'That is your current number of users.'
          : data.error === 'invalid_users' ? 'Enter a whole number of users from 51 to 100,000.'
            : 'Could not price the change right now. Please try again shortly.');
        return;
      }
      pendingUsers = users;
      const now = data.charge_now !== null && data.currency_code
        ? minorUnits(data.charge_now, data.currency_code) : null;
      document.getElementById('users-preview').textContent =
        'Change to ' + users + ' users (' + money(users * UNIT_PRICE_USD) + ' per year). ' +
        (now !== null
          ? (Number(data.charge_now) > 0 ? 'You will be charged ' + now + ' now for the rest of this year.'
            : 'The unused part of this year is credited to your next bill.')
          : 'The difference for the rest of this year is settled now.');
      document.getElementById('users-confirm').classList.remove('hidden');
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
    }
  }

  async function confirmUsers() {
    if (pendingUsers === null) return;
    const users = pendingUsers;
    const btn = document.getElementById('users-confirm-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/portal/billing/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: users }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Could not change your users (' + (data.error || res.status) + ').');
        return;
      }
      document.getElementById('users-confirm').classList.add('hidden');
      showAlert('success', 'Changing your plan to ' + users + ' users. Your license updates in a few seconds.');
      waitForBilling(function (b) { return !!(b.subscription && b.subscription.quantity === users); });
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
      pendingUsers = null;
    }
  }

  async function openBillingPortal() {
    const btn = document.getElementById('portal-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/portal/billing/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showAlert('error', 'Billing management is unavailable right now. Please try again shortly.'); return; }
      location.href = data.url;
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
    }
  }

  // Paddle tells the site about payments by webhook, a moment after the
  // checkout itself; poll until the change shows, then redraw everything.
  async function waitForBilling(done) {
    for (let i = 0; i < 20; i++) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      const b = await fetchJson('/api/portal/billing');
      if (done(b)) {
        renderBilling(b);
        renderDashboard(await fetchJson('/api/portal/dashboard'));
        showAlert('success', 'Your plan is updated. Download your new license.json from the License card and upload it in ADPassSync.');
        return;
      }
    }
    showAlert('info', 'Your payment is still being processed. Refresh this page in a minute.');
  }

  function money(usd) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(usd);
  }

  // Paddle amounts are strings in the currency's smallest unit.
  function minorUnits(amount, currency) {
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency })
      .format(Number(amount) / Math.pow(10, digits));
  }

  function renderDashboard(data) {
    const c = data.customer;
    renderCustomer(c);

    // Onboarding banner: surface a CTA only when both profile fields are blank,
    // i.e. this is genuinely a first-time visit.
    const onboard = document.getElementById('onboarding-card');
    if (!c.name && !c.company) onboard.classList.remove('hidden');
    else onboard.classList.add('hidden');

    renderLicense(data);

    // The release the download button serves right now (null if the
    // release manifest couldn't be read; the line then stays hidden).
    const rel = data.release;
    const relLine = document.getElementById('release-line');
    if (rel) {
      const parts = ['Version ' + rel.version];
      if (rel.released_at) parts.push('released ' + new Date(rel.released_at).toLocaleDateString());
      if (rel.package_size) parts.push((rel.package_size / 1048576).toFixed(1) + ' MB');
      relLine.textContent = parts.join(' · ');
      relLine.classList.remove('hidden');
    }

    const downloads = data.downloads || [];
    const dlBlock = document.getElementById('downloads-block');
    if (downloads.length) {
      let html = '<table><thead><tr><th>When</th><th>Version</th><th>IP</th></tr></thead><tbody>';
      for (const d of downloads) {
        const when = new Date(d.downloaded_at * 1000).toLocaleString();
        html += '<tr>' +
          '<td>' + escapeText(when) + '</td>' +
          '<td class="mono">' + escapeText(d.version || '—') + '</td>' +
          '<td class="mono muted">' + escapeText(d.ip_address || '—') + '</td>' +
        '</tr>';
      }
      html += '</tbody></table>';
      dlBlock.innerHTML = html;
    }
  }

  // What the customer is licensed for, their registered installation, and
  // either its license file or the form to register one.
  function renderLicense(data) {
    const ent = data.entitlement;
    const lic = data.license;
    const installId = data.customer.install_id;
    let html = '';
    if (ent.lapsed) {
      html += '<div class="alert info">Your ' + escapeText(ent.lapsed.tier) + ' term ended on ' +
        escapeText(day(ent.lapsed.expired_at)) + '. You are on the free tier until it is renewed.</div>';
    }
    html += '<dl class="kv">' +
      '<dt>Tier</dt><dd><span class="badge ' + escapeAttr(ent.tier) + '">' + escapeText(ent.tier) + '</span></dd>' +
      '<dt>Licensed AD users</dt><dd>' + (ent.max_users === 0 ? 'Unlimited' : escapeText(String(ent.max_users))) + '</dd>' +
      '<dt>Expires</dt><dd>' + (ent.expires_at ? escapeText(day(ent.expires_at)) : 'Never') + '</dd>' +
      '<dt>Installation</dt><dd class="mono">' +
        (installId ? escapeText(installId) : '<span class="muted">Not registered</span>') + '</dd>' +
      (lic
        ? '<dt>License file</dt><dd style="word-break:normal">Issued ' + escapeText(day(lic.issued_at)) +
          (lic.downloaded_at ? ', downloaded ' + escapeText(day(lic.downloaded_at)) : ', not downloaded yet') + '</dd>'
        : '') +
      '</dl>';
    document.getElementById('license-block').innerHTML = html;

    document.getElementById('license-file-block').classList.toggle('hidden', !lic);
    // Registered but no current file (e.g. a paid term ended): re-submitting
    // the same Install ID issues one from the current entitlement.
    const form = document.getElementById('register-form');
    const input = document.getElementById('r-install');
    form.classList.toggle('hidden', !!lic);
    input.value = installId || '';
    input.readOnly = !!installId;
    document.getElementById('register-help').classList.toggle('hidden', !!installId);
    document.getElementById('register-btn').textContent = installId ? 'Issue license file' : 'Register installation';
  }

  async function submitRegister(e) {
    e.preventDefault();
    const btn = document.getElementById('register-btn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Registering…';
    try {
      const res = await fetch('/api/portal/installation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install_id: document.getElementById('r-install').value }),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', 'License file ready. Download license.json and upload it on the License page of the ADPassSync admin console.');
        const fresh = await fetchJson('/api/portal/dashboard');
        renderLicense(fresh);
        renderCustomer(fresh.customer);
      } else if (data.error === 'invalid_install_id') {
        showAlert('error', 'That is not an Install ID. Copy it from the License page in the ADPassSync admin console.');
      } else if (data.error === 'install_id_registered_elsewhere') {
        showAlert('error', 'That installation is registered to a different account.');
      } else if (data.error === 'account_has_installation') {
        showAlert('error', 'Your account already licenses another installation (' + data.install_id +
          '). If you have moved ADPassSync to a new server, contact us and we will move your license.');
      } else {
        showAlert('error', 'Could not register the installation (' + (data.error || res.status) + ').');
      }
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function day(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleDateString();
  }

  async function submitPurchase(e) {
    e.preventDefault();
    const seats = Number(document.getElementById('seats').value);
    const tier = document.getElementById('tier').value;
    const notes = document.getElementById('notes').value;
    const btn = document.getElementById('purchase-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/portal/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: tier, seats: seats, notes: notes }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Could not record request: ' + (data.error || 'unknown'));
      } else {
        showAlert('success', 'Got it — we\'ll be in touch shortly. Reference: ' + data.purchase.id);
        e.target.reset();
        document.getElementById('seats').value = '100';
      }
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Request quote';
    }
  }

  function renderCustomer(c) {
    document.getElementById('acct-email').textContent = c.email;
    document.getElementById('acct-id').textContent = c.id;
    if (c.install_id) {
      document.getElementById('acct-install').textContent = c.install_id;
    } else {
      document.getElementById('acct-install').innerHTML =
        '<span class="muted">— not registered —</span>';
    }
    // Pre-fill the profile form with whatever's already saved.
    document.getElementById('p-name').value = c.name || '';
    document.getElementById('p-company').value = c.company || '';

    // Greeting in the page header.
    const greeting = document.getElementById('greeting');
    const sub = document.getElementById('greeting-sub');
    if (c.name) {
      greeting.textContent = 'Welcome back, ' + firstName(c.name);
      sub.textContent = 'Manage your ADPassSync license and download installers.';
    } else {
      greeting.textContent = 'Welcome to your portal';
      sub.textContent = c.email;
    }
  }

  function firstName(full) {
    const parts = String(full).trim().split(/\s+/);
    return parts[0] || full;
  }

  async function submitProfile(e) {
    e.preventDefault();
    const name = document.getElementById('p-name').value.trim();
    const company = document.getElementById('p-company').value.trim();
    const btn = document.getElementById('profile-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/portal/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, company: company }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Could not save profile: ' + (data.error || res.status));
      } else {
        showAlert('success', 'Profile saved.');
        if (data.customer) renderCustomer(data.customer);
        document.getElementById('onboarding-card').classList.add('hidden');
      }
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save profile';
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = '/portal/';
    }
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/portal/'; throw new Error('unauthenticated'); }
    if (!res.ok) throw new Error(url + ' ' + res.status);
    return res.json();
  }

  function showAlert(kind, msg) {
    alertBox.className = 'alert ' + kind;
    alertBox.textContent = msg;
    alertBox.classList.remove('hidden');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function escapeText(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function escapeAttr(s) { return String(s).replace(/[^a-z0-9_-]/gi, ''); }
})();
