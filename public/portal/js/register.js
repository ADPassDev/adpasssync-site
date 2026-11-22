// Registers the installation named in ?install_id= (sent here by the License
// page of the ADPassSync admin console) to the signed-in account, then offers
// its license.json. Signs the customer in first if needed, returning here.
(function () {
  'use strict';

  const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const installId = (new URLSearchParams(location.search).get('install_id') || '').trim().toLowerCase();

  const alertBox = document.getElementById('alert');
  const loading = document.getElementById('loading');
  const confirmBox = document.getElementById('confirm');
  const doneBox = document.getElementById('done');
  const registerBtn = document.getElementById('register-btn');

  registerBtn.addEventListener('click', register);

  init().catch(function (e) {
    console.error(e);
    fail('Could not load your account. Please refresh.');
  });

  async function init() {
    if (!INSTALL_ID_RE.test(installId)) {
      fail('This link has no valid Install ID. In ADPassSync, open License and click ' +
        '"Get a license" again, or enter the Install ID on your dashboard.');
      return;
    }
    const me = await (await fetch('/api/auth/me')).json();
    if (!me.authenticated) {
      location.href = '/portal/?next=' + encodeURIComponent('/portal/register?install_id=' + installId);
      return;
    }

    const data = await fetchJson('/api/portal/dashboard');
    const current = data.customer.install_id;
    if (current && current !== installId) {
      fail(otherInstallationMessage(current));
      return;
    }
    if (current === installId && data.license) {
      showDone(data.license, false);
      return;
    }

    document.getElementById('c-install').textContent = installId;
    document.getElementById('c-email').textContent = data.customer.email;
    document.getElementById('c-name').textContent = data.license_customer_name;
    document.getElementById('c-entitlement').textContent = describe(data.entitlement);
    loading.classList.add('hidden');
    confirmBox.classList.remove('hidden');
  }

  async function register() {
    registerBtn.disabled = true;
    registerBtn.textContent = 'Registering…';
    alertBox.classList.add('hidden');
    try {
      const res = await fetch('/api/portal/installation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ install_id: installId }),
      });
      const data = await res.json();
      if (res.ok) {
        confirmBox.classList.add('hidden');
        showDone(data.license, data.registered);
        return;
      }
      if (data.error === 'account_has_installation') {
        fail(otherInstallationMessage(data.install_id));
      } else if (data.error === 'install_id_registered_elsewhere') {
        fail('This installation is already registered to a different account. Sign in with that ' +
          'account, or contact us if that is not right.');
      } else {
        showAlert('error', 'Could not register the installation (' + (data.error || res.status) + '). Please try again.');
      }
    } catch (err) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'Register and get license';
    }
  }

  function showDone(license, justRegistered) {
    loading.classList.add('hidden');
    document.getElementById('done-summary').textContent =
      (justRegistered ? 'Installation registered. ' : 'This installation is registered to your account. ') +
      'Its license: ' + describe(license) + '.';
    doneBox.classList.remove('hidden');
  }

  function otherInstallationMessage(current) {
    return 'Your account already licenses another installation (Install ID ' + current + '). ' +
      'An account licenses one installation; if you have moved ADPassSync to a new server, ' +
      'contact us and we will move your license.';
  }

  function describe(e) {
    const tier = e.tier.charAt(0).toUpperCase() + e.tier.slice(1);
    const users = e.max_users === 0 ? 'unlimited AD users' : e.max_users + ' AD users';
    const until = e.expires_at ? ', until ' + new Date(e.expires_at * 1000).toLocaleDateString() : '';
    return tier + ', ' + users + until;
  }

  function fail(msg) {
    loading.classList.add('hidden');
    confirmBox.classList.add('hidden');
    showAlert('error', msg);
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ' ' + res.status);
    return res.json();
  }

  function showAlert(kind, msg) {
    alertBox.className = 'alert ' + kind;
    alertBox.textContent = msg;
    alertBox.classList.remove('hidden');
  }
})();
