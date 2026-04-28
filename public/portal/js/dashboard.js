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

    const data = await fetchJson('/api/portal/dashboard');
    renderDashboard(data);

    loading.classList.add('hidden');
    content.classList.remove('hidden');
  }

  function renderDashboard(data) {
    const c = data.customer;
    renderCustomer(c);

    // Onboarding banner: surface a CTA only when both profile fields are blank,
    // i.e. this is genuinely a first-time visit.
    const onboard = document.getElementById('onboarding-card');
    if (!c.name && !c.company) onboard.classList.remove('hidden');
    else onboard.classList.add('hidden');

    const lic = data.license;
    const licBlock = document.getElementById('license-block');
    if (lic) {
      const issued = new Date(lic.issued_at * 1000).toLocaleDateString();
      const expires = lic.expires_at
        ? new Date(lic.expires_at * 1000).toLocaleDateString()
        : 'Perpetual';
      const downloaded = lic.downloaded_at
        ? new Date(lic.downloaded_at * 1000).toLocaleString()
        : 'Not yet downloaded';
      licBlock.innerHTML =
        '<dl class="kv">' +
          '<dt>Tier</dt><dd><span class="badge ' + escapeAttr(lic.tier) + '">' + escapeText(lic.tier) + '</span></dd>' +
          '<dt>Max AD users</dt><dd>' + escapeText(String(lic.max_users)) + '</dd>' +
          '<dt>Issued</dt><dd>' + escapeText(issued) + '</dd>' +
          '<dt>Expires</dt><dd>' + escapeText(expires) + '</dd>' +
          '<dt>Last downloaded</dt><dd>' + escapeText(downloaded) + '</dd>' +
        '</dl>';
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
        '<span class="muted">— assigned on first download —</span>';
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
