// Admin page. Lists customers, lets an operator issue licenses, and shows
// a detail view (license + downloads) for any selected customer.
(function () {
  'use strict';

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const alertBox = document.getElementById('alert');
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('issue-form').addEventListener('submit', issueLicense);

  init().catch(function (e) {
    console.error(e);
    showAlert('error', 'Could not load admin: ' + e.message);
  });

  async function init() {
    const me = await fetchJson('/api/auth/me');
    if (!me.authenticated) { location.href = '/portal/'; return; }
    if (!me.is_admin) { location.href = '/portal/dashboard.html'; return; }
    document.getElementById('user-email').textContent = me.customer.email;
    await refreshCustomers();
  }

  async function refreshCustomers() {
    const data = await fetchJson('/api/admin/customers');
    const block = document.getElementById('customers-block');
    if (!data.customers.length) {
      block.innerHTML = '<p class="muted">No customers yet.</p>';
      return;
    }
    let html = '<table><thead><tr>' +
      '<th>Email</th><th>Company</th><th>Customer ID</th><th>Install ID</th><th>Created</th><th></th>' +
      '</tr></thead><tbody>';
    for (const c of data.customers) {
      const created = new Date(c.created_at * 1000).toLocaleDateString();
      html += '<tr>' +
        '<td>' + escapeText(c.email) + '</td>' +
        '<td>' + escapeText(c.company || '—') + '</td>' +
        '<td class="mono">' + escapeText(c.id) + '</td>' +
        '<td class="mono muted">' + escapeText(c.install_id || '—') + '</td>' +
        '<td>' + escapeText(created) + '</td>' +
        '<td><button class="btn btn-secondary view-btn" data-id="' + escapeAttr(c.id) + '" type="button" style="padding:0.4rem 0.8rem;font-size:0.85rem">View</button></td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    block.innerHTML = html;
    block.querySelectorAll('.view-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        viewCustomer(btn.getAttribute('data-id'));
      });
    });
  }

  async function viewCustomer(id) {
    const data = await fetchJson('/api/admin/customer/' + encodeURIComponent(id));
    const card = document.getElementById('detail-card');
    const block = document.getElementById('detail-block');
    document.getElementById('detail-title').textContent = 'Customer: ' + data.customer.email;

    let html = '<dl class="kv">' +
      '<dt>Customer ID</dt><dd class="mono">' + escapeText(data.customer.id) + '</dd>' +
      '<dt>Email</dt><dd>' + escapeText(data.customer.email) + '</dd>' +
      '<dt>Company</dt><dd>' + escapeText(data.customer.company || '—') + '</dd>' +
      '<dt>Install ID</dt><dd class="mono">' + escapeText(data.customer.install_id || '—') + '</dd>' +
      '</dl>';

    if (data.license) {
      const lic = data.license;
      html += '<h2 style="margin-top:1.5rem">Active license</h2>' +
        '<dl class="kv">' +
          '<dt>License ID</dt><dd class="mono">' + escapeText(lic.id) + '</dd>' +
          '<dt>Tier</dt><dd><span class="badge ' + escapeAttr(lic.tier) + '">' + escapeText(lic.tier) + '</span></dd>' +
          '<dt>Max users</dt><dd>' + escapeText(String(lic.max_users)) + '</dd>' +
          '<dt>Issued</dt><dd>' + escapeText(new Date(lic.issued_at * 1000).toLocaleString()) + '</dd>' +
          '<dt>Expires</dt><dd>' + (lic.expires_at ? escapeText(new Date(lic.expires_at * 1000).toLocaleString()) : 'Perpetual') + '</dd>' +
        '</dl>' +
        '<details style="margin-top:1rem"><summary class="muted">Show license_json</summary>' +
        '<pre class="mono" style="margin-top:0.5rem;white-space:pre-wrap;background:#0d1422;padding:1rem;border-radius:8px;border:1px solid var(--border-strong)">' +
        escapeText(lic.license_json) + '</pre></details>';
    } else {
      html += '<p class="muted" style="margin-top:1rem">No active license.</p>';
    }

    if (data.downloads && data.downloads.length) {
      html += '<h2 style="margin-top:1.5rem">Recent downloads</h2><table><thead><tr><th>When</th><th>Version</th><th>IP</th></tr></thead><tbody>';
      for (const d of data.downloads) {
        html += '<tr>' +
          '<td>' + escapeText(new Date(d.downloaded_at * 1000).toLocaleString()) + '</td>' +
          '<td class="mono">' + escapeText(d.version || '—') + '</td>' +
          '<td class="mono muted">' + escapeText(d.ip_address || '—') + '</td>' +
        '</tr>';
      }
      html += '</tbody></table>';
    }

    block.innerHTML = html;
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function issueLicense(e) {
    e.preventDefault();
    const customer_id = document.getElementById('cust-id').value.trim();
    const tier = document.getElementById('i-tier').value;
    const max_users = Number(document.getElementById('i-max').value);
    const expRaw = document.getElementById('i-exp').value.trim();
    let expires_at = null;
    if (expRaw) {
      const t = Date.parse(expRaw);
      if (Number.isNaN(t)) { showAlert('error', 'Invalid expiry date.'); return; }
      expires_at = Math.floor(t / 1000);
    }
    const btn = document.getElementById('issue-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await fetch('/api/admin/license/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customer_id, tier: tier, max_users: max_users, expires_at: expires_at }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : ''));
      } else {
        showAlert('success', 'License ' + data.license.id + ' issued.');
        await refreshCustomers();
        await viewCustomer(customer_id);
      }
    } catch (err) {
      showAlert('error', 'Network error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate license';
    }
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); }
    finally { location.href = '/portal/'; }
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/portal/'; throw new Error('unauthenticated'); }
    if (res.status === 403) { location.href = '/portal/dashboard.html'; throw new Error('forbidden'); }
    if (!res.ok) throw new Error(url + ' ' + res.status);
    return res.json();
  }

  function showAlert(kind, msg) {
    alertBox.className = 'alert ' + kind;
    alertBox.textContent = msg;
    alertBox.classList.remove('hidden');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function escapeText(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function escapeAttr(s) { return String(s).replace(/[^a-z0-9_-]/gi, ''); }
})();
