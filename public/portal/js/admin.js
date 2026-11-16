// Admin page. Lists quote requests and customers, sets what a customer is
// licensed for (which issues a license for their registered installation),
// and shows a detail view (entitlement, installation, license, downloads)
// with a reset for moving a customer to a new installation.
(function () {
  'use strict';

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const alertBox = document.getElementById('alert');
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('issue-form').addEventListener('submit', setEntitlement);
  document.getElementById('purchase-filter').addEventListener('change', refreshPurchases);

  init().catch(function (e) {
    console.error(e);
    showAlert('error', 'Could not load admin: ' + e.message);
  });

  async function init() {
    const me = await fetchJson('/api/auth/me');
    if (!me.authenticated) { location.href = '/portal/'; return; }
    if (!me.is_admin) { location.href = '/portal/dashboard.html'; return; }
    document.getElementById('user-email').textContent = me.customer.email;
    await Promise.all([refreshPurchases(), refreshCustomers()]);
  }

  async function refreshPurchases() {
    const filter = document.getElementById('purchase-filter').value;
    const url = '/api/admin/purchases' + (filter ? '?status=' + encodeURIComponent(filter) : '');
    const data = await fetchJson(url);
    const block = document.getElementById('purchases-block');
    if (!data.purchases.length) {
      block.innerHTML = '<p class="muted">No quote requests' + (filter ? ' with status "' + escapeText(filter) + '"' : '') + '.</p>';
      return;
    }
    let html = '<table><thead><tr>' +
      '<th>Submitted</th><th>Customer</th><th>Tier</th><th>Seats</th><th>Status</th><th>Notes</th><th></th>' +
      '</tr></thead><tbody>';
    for (const p of data.purchases) {
      const submitted = new Date(p.created_at * 1000).toLocaleString();
      const who = (p.customer_name ? escapeText(p.customer_name) + '<br>' : '') +
        '<span class="mono muted" style="font-size:0.8rem">' + escapeText(p.customer_email) + '</span>' +
        (p.customer_company ? '<br><span class="muted" style="font-size:0.8rem">' + escapeText(p.customer_company) + '</span>' : '');
      const notes = p.notes
        ? '<details><summary class="muted" style="cursor:pointer">' + (p.notes.length > 40 ? escapeText(p.notes.slice(0, 40)) + '…' : escapeText(p.notes)) + '</summary>' +
          '<div style="white-space:pre-wrap;margin-top:0.4rem;font-size:0.85rem">' + escapeText(p.notes) + '</div></details>'
        : '<span class="muted">—</span>';
      const actions = renderPurchaseActions(p);
      html += '<tr>' +
        '<td>' + escapeText(submitted) + '</td>' +
        '<td>' + who + '</td>' +
        '<td><span class="badge ' + escapeAttr(p.tier) + '">' + escapeText(p.tier) + '</span></td>' +
        '<td>' + escapeText(String(p.seats)) + '</td>' +
        '<td><span class="badge ' + statusBadgeClass(p.status) + '">' + escapeText(p.status) + '</span></td>' +
        '<td>' + notes + '</td>' +
        '<td>' + actions + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    block.innerHTML = html;
    block.querySelectorAll('.purchase-action').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setPurchaseStatus(btn.getAttribute('data-id'), btn.getAttribute('data-status'));
      });
    });
  }

  function renderPurchaseActions(p) {
    const btn = function (status, label) {
      return '<button type="button" class="btn btn-secondary purchase-action" ' +
        'data-id="' + escapeAttr(p.id) + '" data-status="' + escapeAttr(status) + '" ' +
        'style="padding:0.3rem 0.7rem;font-size:0.8rem;margin-right:0.25rem">' + label + '</button>';
    };
    if (p.status === 'pending') return btn('paid', 'Mark paid') + btn('cancelled', 'Cancel');
    if (p.status === 'paid')    return btn('pending', 'Reopen') + btn('cancelled', 'Cancel');
    return btn('pending', 'Reopen');
  }

  function statusBadgeClass(s) {
    if (s === 'paid')      return 'professional';
    if (s === 'cancelled') return 'muted';
    return 'free'; // pending -> green like "active"
  }

  async function setPurchaseStatus(id, status) {
    if (!id || !status) return;
    try {
      const res = await fetch('/api/admin/purchase/' + encodeURIComponent(id) + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Status update failed: ' + (data.error || res.status));
      } else {
        let msg = 'Marked ' + status + '.';
        if (status === 'paid' && data.entitlement) {
          msg += ' Entitlement: ' + describeEntitlement(data.entitlement) + '. ' +
            (data.license
              ? 'License issued for installation ' + data.license.install_id + '; the customer was emailed.'
              : 'The customer has no registered installation yet; they get the license when they register one, and were emailed.');
        }
        showAlert('success', msg);
        await refreshPurchases();
      }
    } catch (err) {
      showAlert('error', 'Network error: ' + err.message);
    }
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
    const c = data.customer;
    document.getElementById('detail-title').textContent = 'Customer: ' + c.email;
    // Prefill the entitlement form for this customer.
    document.getElementById('cust-id').value = c.id;

    let html = '<dl class="kv">' +
      '<dt>Customer ID</dt><dd class="mono">' + escapeText(c.id) + '</dd>' +
      '<dt>Email</dt><dd>' + escapeText(c.email) + '</dd>' +
      '<dt>Company</dt><dd>' + escapeText(c.company || '—') + '</dd>' +
      '<dt>Installation</dt><dd class="mono">' + escapeText(c.install_id || 'Not registered') + '</dd>' +
      '</dl>';

    const eff = data.effective;
    html += '<h2 style="margin-top:1.5rem">Entitlement</h2><dl class="kv">' +
      '<dt>In force</dt><dd>' + escapeText(describeEntitlement(eff)) + '</dd>' +
      (data.entitlement
        ? '<dt>Recorded</dt><dd>' + escapeText(describeEntitlement(data.entitlement)) +
          (data.entitlement.source ? ' <span class="muted">(' + escapeText(data.entitlement.source) + ')</span>' : '') + '</dd>'
        : '<dt>Recorded</dt><dd class="muted">None (free tier)</dd>') +
      '</dl>';

    if (data.subscriptions && data.subscriptions.length) {
      const when = function (t) { return t ? escapeText(new Date(t * 1000).toLocaleDateString()) : '—'; };
      html += '<h2 style="margin-top:1.5rem">Paddle subscriptions</h2><table><thead><tr>' +
        '<th>Subscription</th><th>Status</th><th>Users</th><th>Paid through</th><th>Cancels</th><th>Refunded</th>' +
        '</tr></thead><tbody>';
      for (const s of data.subscriptions) {
        html += '<tr>' +
          '<td class="mono">' + escapeText(s.id) + '</td>' +
          '<td>' + escapeText(s.status) + '</td>' +
          '<td>' + escapeText(String(s.quantity)) + '</td>' +
          '<td>' + when(s.paid_through) + '</td>' +
          '<td>' + when(s.cancel_at) + '</td>' +
          '<td>' + when(s.refunded_at) + '</td>' +
        '</tr>';
      }
      html += '</tbody></table><p class="muted" style="margin-top:0.5rem;font-size:0.85rem">' +
        'Paddle sets the entitlement of customers with a paid subscription; saving one here is ' +
        'overwritten by the next Paddle event.</p>';
    }
    if (data.hashdb_key) {
      html += '<dl class="kv" style="margin-top:1rem"><dt>Bloom filter key</dt><dd class="mono">' +
        escapeText(data.hashdb_key) + '</dd></dl>';
    }

    if (data.license) {
      const lic = data.license;
      html += '<h2 style="margin-top:1.5rem">Current license file</h2>' +
        '<dl class="kv">' +
          '<dt>License ID</dt><dd class="mono">' + escapeText(lic.id) + '</dd>' +
          '<dt>Installation</dt><dd class="mono">' + escapeText(lic.install_id) + '</dd>' +
          '<dt>Grants</dt><dd>' + escapeText(describeEntitlement(lic)) + '</dd>' +
          '<dt>Issued</dt><dd>' + escapeText(new Date(lic.issued_at * 1000).toLocaleString()) + '</dd>' +
          '<dt>Downloaded</dt><dd>' + (lic.downloaded_at ? escapeText(new Date(lic.downloaded_at * 1000).toLocaleString()) : 'Not yet') + '</dd>' +
        '</dl>' +
        '<details style="margin-top:1rem"><summary class="muted">Show license.json</summary>' +
        '<pre class="mono" style="margin-top:0.5rem;white-space:pre-wrap;background:#0d1422;padding:1rem;border-radius:8px;border:1px solid var(--border-strong)">' +
        escapeText(lic.license_json) + '</pre></details>';
    } else {
      html += '<p class="muted" style="margin-top:1rem">No current license file.</p>';
    }

    if (c.install_id) {
      html += '<div style="margin-top:1.5rem">' +
        '<button type="button" class="btn btn-secondary" id="reset-install-btn">Reset installation</button>' +
        '<p class="muted" style="margin-top:0.5rem;line-height:1.5">Unbinds ' + escapeText(c.install_id) +
        ' and revokes its license so the customer can register a new installation. The old installation ' +
        'keeps working with the file it has until that license expires.</p></div>';
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
    const resetBtn = document.getElementById('reset-install-btn');
    if (resetBtn) resetBtn.addEventListener('click', function () { resetInstallation(c.id, resetBtn); });
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function resetInstallation(customerId, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/customer/' + encodeURIComponent(customerId) + '/installation/reset', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Reset failed: ' + (data.error || res.status));
      } else {
        showAlert('success', 'Installation ' + data.previous_install_id + ' unbound. The customer can register a new one.');
        await refreshCustomers();
        await viewCustomer(customerId);
      }
    } catch (err) {
      showAlert('error', 'Network error: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function setEntitlement(e) {
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
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/admin/entitlement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customer_id, tier: tier, max_users: max_users, expires_at: expires_at }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', 'Failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : ''));
      } else {
        showAlert('success', 'Entitlement saved: ' + describeEntitlement(data.effective) + '. ' +
          (data.license
            ? 'License issued for installation ' + data.license.install_id + '.'
            : 'No installation registered yet; the license is issued when the customer registers one.'));
        await refreshCustomers();
        await viewCustomer(customer_id);
      }
    } catch (err) {
      showAlert('error', 'Network error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save entitlement';
    }
  }

  function describeEntitlement(e) {
    const users = e.max_users === 0 ? 'unlimited users' : e.max_users + ' users';
    const until = e.expires_at ? ', until ' + new Date(e.expires_at * 1000).toLocaleDateString() : ', no expiry';
    return e.tier + ', ' + users + until;
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
