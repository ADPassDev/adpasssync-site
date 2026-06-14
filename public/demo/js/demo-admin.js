// Admin Console demo. Shows a (pre-filled) sign-in screen, then a dashboard
// whose stats and activity feed are built from the shared sandbox — so a reset
// done on the Self-Service page appears here immediately.
(function () {
  'use strict';

  var SESSION_FLAG = 'adps_demo_admin_in';
  var app = document.getElementById('app');
  var whoBar = document.getElementById('who-bar');
  var toastEl = document.getElementById('toast');
  var creds = Demo.CREDS.admin;
  var state = Demo.load();

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

  // ---- Sign-in ----
  function renderLogin() {
    app.innerHTML =
      '<div class="login-wrap"><div class="login-box">' +
        '<h1>Admin sign-in</h1>' +
        '<p class="sub">Web-based console for IT. Credentials are pre-filled for the demo.</p>' +
        '<div id="msg"></div>' +
        '<div class="field"><label class="con-label">Email</label>' +
          '<input class="con-input" id="u" value="' + esc(creds.user) + '"></div>' +
        '<div class="field"><label class="con-label">Password</label>' +
          '<input class="con-input" id="p" type="password" value="' + esc(creds.pass) + '"></div>' +
        '<button class="btn-con primary" id="go" style="width:100%; padding:0.7rem;">Sign in</button>' +
        '<div class="prefill-note">Any of the demo logins from the ' +
          '<a href="index.html" style="color:#60a5fa;">demo home</a> page work here.</div>' +
      '</div></div>';
    document.getElementById('go').addEventListener('click', function () {
      setSignedIn(true);
      route();
    });
  }

  // ---- Dashboard ----
  function renderDashboard() {
    state = Demo.load();
    var users = state.users;
    var mfaPct = Math.round(users.filter(function (u) { return u.mfa; }).length / users.length * 100);
    var lockedCount = users.filter(function (u) { return u.status === 'locked'; }).length;

    app.innerHTML =
      '<div class="con-main">' +
        '<div class="con-h1">Dashboard</div>' +
        '<p class="con-sub">Real-time view of reset activity, MFA enrollment and blocked breaches across <span class="mono">' + Demo.DOMAIN + '</span>.</p>' +
        '<div class="stat-grid">' +
          stat('Resets (30d)', state.baseline.resets30d.toLocaleString(), '&#9650; 12% vs last month', 'up') +
          stat('MFA enrollment', mfaPct + '%', users.filter(function (u){return u.mfa;}).length + ' of ' + users.length + ' users') +
          stat('Breaches blocked', state.baseline.breachesBlocked.toLocaleString(), 'lifetime') +
          stat('Locked accounts', String(lockedCount), lockedCount ? 'needs attention' : 'all clear') +
        '</div>' +
        '<div class="panel"><h2>Recent activity</h2>' +
          '<table class="con-table"><thead><tr><th>User</th><th>Event</th><th>Detail</th><th>When</th></tr></thead>' +
          '<tbody>' + activityRows() + '</tbody></table></div>' +
        '<div class="panel"><h2>Users</h2>' +
          '<table class="con-table"><thead><tr><th>User</th><th>OU</th><th>Status</th><th>MFA</th><th>Password age</th></tr></thead>' +
          '<tbody>' + userRows() + '</tbody></table></div>' +
      '</div>';
  }

  function stat(k, v, d, cls) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
      '<div class="d ' + (cls || '') + '">' + d + '</div></div>';
  }

  function activityRows() {
    return state.events.slice(0, 12).map(function (e) {
      var u = Demo.getUser(state, e.target);
      var who = u
        ? '<div class="who-cell"><span class="av">' + esc(u.initials) + '</span>' +
            '<span>' + esc(u.name) + '<small>' + esc(u.email) + '</small></span></div>'
        : esc(e.target);
      return '<tr><td>' + who + '</td><td>' + eventPill(e.action) + '</td><td style="color:#94a3b8;">' +
        esc(e.detail) + '</td><td style="color:#64748b;">' + Demo.fmtAgo(e.ts) + '</td></tr>';
    }).join('');
  }

  function eventPill(action) {
    var map = {
      reset: ['green', 'Reset'],
      unlock: ['blue', 'Unlock'],
      mfa_enroll: ['blue', 'MFA enrolled'],
      lock: ['red', 'Locked'],
      breach_block: ['orange', 'Breach blocked'],
    };
    var m = map[action] || ['muted', action];
    return '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
  }

  function userRows() {
    return state.users.map(function (u) {
      return '<tr><td><div class="who-cell"><span class="av">' + esc(u.initials) + '</span>' +
        '<span>' + esc(u.name) + '<small>' + esc(u.email) + '</small></span></div></td>' +
        '<td style="color:#94a3b8;">' + esc(u.ou) + '</td>' +
        '<td>' + (u.status === 'locked' ? '<span class="pill red">Locked</span>' : '<span class="pill green">Active</span>') + '</td>' +
        '<td>' + (u.mfa ? '<span class="pill blue">Enrolled</span>' : '<span class="pill muted">None</span>') + '</td>' +
        '<td style="color:' + (u.pwAgeDays > 80 ? '#fbbf24' : '#94a3b8') + ';">' + u.pwAgeDays + ' days</td></tr>';
    }).join('');
  }

  function route() {
    renderWhoBar();
    if (isSignedIn()) renderDashboard();
    else renderLogin();
  }

  route();
})();
