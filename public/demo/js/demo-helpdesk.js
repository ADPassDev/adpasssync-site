// Helpdesk demo. Pre-filled sign-in, then a user search where an agent can
// reset, unlock, or force MFA re-enrollment on a user's behalf. Actions write
// to the shared sandbox and appear in the Admin Console activity feed.
(function () {
  'use strict';

  var SESSION_FLAG = 'adps_demo_help_in';
  var ACTOR = 'helpdesk';
  var app = document.getElementById('app');
  var whoBar = document.getElementById('who-bar');
  var toastEl = document.getElementById('toast');
  var creds = Demo.CREDS.helpdesk;
  var state = Demo.load();
  var query = '';

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  function isSignedIn() {
    try { return sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (e) { return false; }
  }
  function setSignedIn(v) {
    try { v ? sessionStorage.setItem(SESSION_FLAG, '1') : sessionStorage.removeItem(SESSION_FLAG); } catch (e) {}
  }

  function renderWhoBar() {
    if (isSignedIn()) {
      whoBar.innerHTML = '<span>' + esc(creds.user) + '</span><button id="signout">Sign out</button>';
      document.getElementById('signout').addEventListener('click', function () {
        setSignedIn(false); route();
      });
    } else {
      whoBar.innerHTML = '';
    }
  }

  function renderLogin() {
    app.innerHTML =
      '<div class="login-wrap"><div class="login-box">' +
        '<h1>Helpdesk sign-in</h1>' +
        '<p class="sub">Tier-limited console for first-line support. Pre-filled for the demo.</p>' +
        '<div class="field"><label class="con-label">Email</label>' +
          '<input class="con-input" id="u" value="' + esc(creds.user) + '"></div>' +
        '<div class="field"><label class="con-label">Password</label>' +
          '<input class="con-input" id="p" type="password" value="' + esc(creds.pass) + '"></div>' +
        '<button class="btn-con primary" id="go" style="width:100%; padding:0.7rem;">Sign in</button>' +
        '<div class="prefill-note">A helpdesk role can reset and unlock users but cannot change ' +
          'domain policy — that\'s admin-only.</div>' +
      '</div></div>';
    document.getElementById('go').addEventListener('click', function () {
      setSignedIn(true); route();
    });
  }

  function renderDesk() {
    state = Demo.load();
    var results = Demo.findUsers(state, query);
    app.innerHTML =
      '<div class="con-main">' +
        '<div class="con-h1">User lookup</div>' +
        '<p class="con-sub">Search a user, then reset, unlock, or re-enroll MFA on their behalf.</p>' +
        '<div class="field" style="max-width:420px; margin-bottom:1.5rem;">' +
          '<input class="con-input" id="q" placeholder="Search name, username or email…" value="' + esc(query) + '"></div>' +
        '<div class="panel"><table class="con-table">' +
          '<thead><tr><th>User</th><th>Status</th><th>MFA</th><th>Actions</th></tr></thead>' +
          '<tbody>' + (results.length ? results.map(rowFor).join('') :
            '<tr><td colspan="4" style="color:#64748b;">No users match “' + esc(query) + '”.</td></tr>') +
          '</tbody></table></div>' +
      '</div>';

    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      query = q.value;
      var pos = q.selectionStart;
      renderDesk();
      var nq = document.getElementById('q');
      nq.focus();
      try { nq.setSelectionRange(pos, pos); } catch (e) {}
    });

    [].forEach.call(app.querySelectorAll('[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        doAction(btn.getAttribute('data-act'), btn.getAttribute('data-user'));
      });
    });
  }

  function rowFor(u) {
    return '<tr>' +
      '<td><div class="who-cell"><span class="av">' + esc(u.initials) + '</span>' +
        '<span>' + esc(u.name) + '<small>' + esc(u.email) + '</small></span></div></td>' +
      '<td>' + (u.status === 'locked' ? '<span class="pill red">Locked</span>' : '<span class="pill green">Active</span>') + '</td>' +
      '<td>' + (u.mfa ? '<span class="pill blue">Enrolled</span>' : '<span class="pill muted">None</span>') + '</td>' +
      '<td><div class="con-actions">' +
        '<button class="btn-con primary" data-act="reset" data-user="' + u.username + '">Reset password</button>' +
        '<button class="btn-con" data-act="unlock" data-user="' + u.username + '"' +
          (u.status === 'locked' ? '' : ' disabled') + '>Unlock</button>' +
        '<button class="btn-con" data-act="mfa" data-user="' + u.username + '"' +
          (u.mfa ? ' disabled' : '') + '>Force MFA</button>' +
      '</div></td></tr>';
  }

  function doAction(act, username) {
    var u = Demo.getUser(state, username);
    if (!u) return;
    if (act === 'reset') {
      Demo.resetPassword(state, username, { actor: ACTOR, detail: 'Password reset by helpdesk (temp password issued)' });
      toast('Temp password issued for ' + u.name + ' — user must change at next sign-in');
    } else if (act === 'unlock') {
      Demo.unlockAccount(state, username, { actor: ACTOR, detail: 'Unlocked by helpdesk' });
      toast(u.name + ' unlocked');
    } else if (act === 'mfa') {
      Demo.enrollMfa(state, username, { actor: ACTOR, detail: 'MFA re-enrollment forced by helpdesk' });
      toast('MFA re-enrollment forced for ' + u.name);
    }
    renderDesk();
  }

  function route() {
    renderWhoBar();
    if (isSignedIn()) renderDesk();
    else renderLogin();
  }

  route();
})();
