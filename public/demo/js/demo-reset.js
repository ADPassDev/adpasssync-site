// Self-Service Portal demo. A tiny client-side view router drives the four
// flows (Reset / Change / Unlock / Enroll MFA) plus the Home tile screen.
// Each flow mutates the shared sandbox via window.Demo so actions show up in
// the Admin Console and Helpdesk views.
(function () {
  'use strict';

  var state = Demo.load();
  var viewEl = document.getElementById('view');
  var tabs = document.getElementById('tabs');
  var toastEl = document.getElementById('toast');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function setTab(view) {
    [].forEach.call(tabs.querySelectorAll('.ss-tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
  }

  tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.ss-tab');
    if (!btn) return;
    render(btn.getAttribute('data-view'));
  });

  function userOptions(filter) {
    return state.users
      .filter(filter || function () { return true; })
      .map(function (u) {
        return '<option value="' + u.username + '">' + u.name + ' (' + u.email + ')' +
          (u.status === 'locked' ? ' — locked' : '') + '</option>';
      })
      .join('');
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  // ---- Home ----
  function viewHome() {
    setTab('home');
    viewEl.innerHTML =
      '<div class="ss-tiles">' +
        tile('reset', '&#128272;', 'Reset Password', 'Forgot your password? Reset it using multi-factor authentication.') +
        tile('change', '&#128260;', 'Change Password', 'Update your password using your current credentials.') +
        tile('unlock', '&#128275;', 'Unlock Account', 'Unlock your account after too many failed login attempts.') +
        tile('mfa', '&#128241;', 'Enroll MFA', 'Set up multi-factor authentication for your account.') +
      '</div>';
    [].forEach.call(viewEl.querySelectorAll('[data-go]'), function (el) {
      el.addEventListener('click', function () { render(el.getAttribute('data-go')); });
    });
  }
  function tile(go, ico, title, desc) {
    return '<div class="ss-tile" data-go="' + go + '"><div class="ico">' + ico + '</div>' +
      '<h3>' + title + '</h3><p>' + desc + '</p></div>';
  }

  // ---- Reset Password (identify -> MFA -> new password -> done) ----
  function viewReset() {
    setTab('reset');
    var suggested = Demo.SUGGESTED;
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Reset your password</div>' +
      '<p class="ss-flow-sub">Verify your identity with a second factor, then choose a new password. ' +
        'No current password needed.</p>' +
      '<div class="ss-field"><label>Who are you resetting? (demo)</label>' +
        '<select class="ss-select" id="who">' + userOptions() + '</select></div>' +
      '<button class="btn-ss" id="next">Continue &rarr;</button>';
    document.getElementById('who').value = suggested;
    bindBack();
    document.getElementById('next').addEventListener('click', function () {
      mfaStep(document.getElementById('who').value, 'reset');
    });
  }

  // ---- Unlock Account ----
  function viewUnlock() {
    setTab('unlock');
    var locked = state.users.filter(function (u) { return u.status === 'locked'; });
    if (!locked.length) {
      viewEl.innerHTML = backBtn() +
        '<div class="ss-flow-title">Unlock your account</div>' +
        '<div class="ss-msg info">No accounts are currently locked in the sandbox. ' +
        'Tip: locked accounts show under <strong>Reset Password</strong>.</div>';
      bindBack();
      return;
    }
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Unlock your account</div>' +
      '<p class="ss-flow-sub">Verify a second factor to clear the lockout. Locked after too many failed sign-ins.</p>' +
      '<div class="ss-field"><label>Locked account (demo)</label>' +
        '<select class="ss-select" id="who">' +
          userOptions(function (u) { return u.status === 'locked'; }) + '</select></div>' +
      '<button class="btn-ss" id="next">Continue &rarr;</button>';
    bindBack();
    document.getElementById('next').addEventListener('click', function () {
      mfaStep(document.getElementById('who').value, 'unlock');
    });
  }

  // ---- Change Password (needs current password) ----
  function viewChange() {
    setTab('change');
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Change your password</div>' +
      '<p class="ss-flow-sub">Enter your current password, then a new one that meets policy.</p>' +
      '<div class="ss-field"><label>Account (demo)</label>' +
        '<select class="ss-select" id="who">' +
          userOptions(function (u) { return u.status !== 'locked'; }) + '</select></div>' +
      '<div class="ss-field"><label>Current password</label>' +
        '<input class="ss-input" id="cur" type="password" placeholder="Any value works in the demo"></div>' +
      passwordFields() +
      '<button class="btn-ss" id="submit" disabled>Change password</button>';
    bindBack();
    wirePasswordFields(function (username) {
      Demo.resetPassword(state, username, { actor: username, detail: 'Self-service password change' });
      successScreen(username, 'Password changed', 'Your new password is active across the domain.');
    });
  }

  // ---- Enroll MFA ----
  function viewMfa() {
    setTab('mfa');
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Enroll a second factor</div>' +
      '<p class="ss-flow-sub">Add WebAuthn / FIDO2, an authenticator app, or a security key. ' +
        'In the demo we simulate a platform authenticator.</p>' +
      '<div class="ss-field"><label>Account (demo)</label>' +
        '<select class="ss-select" id="who">' + userOptions() + '</select></div>' +
      '<div class="otp-box"><div class="lbl">Platform authenticator</div>' +
        '<div class="code">&#128273; Touch ID</div>' +
        '<div class="hint">Click below to simulate the WebAuthn prompt</div></div>' +
      '<button class="btn-ss" id="enroll">Register this device</button>';
    bindBack();
    document.getElementById('enroll').addEventListener('click', function () {
      var who = document.getElementById('who').value;
      Demo.enrollMfa(state, who, { actor: who });
      successScreen(who, 'MFA enrolled', 'A second factor is now required on every password operation for this account.');
    });
  }

  // ---- Shared: MFA verification step ----
  function mfaStep(username, mode) {
    var code = Demo.generateOtp(username + '|' + state.createdAt);
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Verify it\'s you</div>' +
      '<p class="ss-flow-sub">We sent a one-time code to the second factor on file for ' +
        '<strong>' + esc(Demo.getUser(state, username).name) + '</strong>.</p>' +
      '<div class="otp-box"><div class="lbl">Your authenticator shows (demo)</div>' +
        '<div class="code">' + code + '</div>' +
        '<div class="hint">Type it below — or just click Verify</div></div>' +
      '<div class="ss-field"><label>6-digit code</label>' +
        '<input class="ss-input" id="otp" inputmode="numeric" maxlength="6" placeholder="' + code + '"></div>' +
      '<div id="otp-msg"></div>' +
      '<button class="btn-ss" id="verify">Verify &rarr;</button>';
    bindBack();
    document.getElementById('verify').addEventListener('click', function () {
      var entered = document.getElementById('otp').value.trim();
      if (entered && entered !== code) {
        document.getElementById('otp-msg').innerHTML =
          '<div class="ss-msg error">That code doesn\'t match. The demo code is ' + code + '.</div>';
        return;
      }
      if (mode === 'unlock') {
        Demo.unlockAccount(state, username, { actor: username, detail: 'Self-service unlock (MFA verified)' });
        successScreen(username, 'Account unlocked', 'You can sign in again right away.');
      } else {
        newPasswordStep(username);
      }
    });
  }

  // ---- Shared: choose new password ----
  function newPasswordStep(username) {
    viewEl.innerHTML =
      backBtn() +
      '<div class="ss-flow-title">Choose a new password</div>' +
      '<p class="ss-flow-sub">Must meet policy and not appear in any known breach.</p>' +
      passwordFields() +
      '<button class="btn-ss" id="submit" disabled>Set new password</button>';
    bindBack();
    wirePasswordFields(function (u) {
      Demo.resetPassword(state, u, { actor: u, detail: 'Self-service reset (MFA verified)' });
      successScreen(u, 'Password reset complete', 'Your new password is active across the domain.');
    }, username);
  }

  function passwordFields() {
    return '' +
      '<div class="ss-field"><label>New password</label>' +
        '<input class="ss-input" id="pw" type="password" placeholder="Try \'Password1\' to see the breach check fire">' +
        '<div class="pw-meter s0" id="meter"><span></span></div>' +
        '<div class="pw-label" id="pw-label">Enter a password</div>' +
        '<div id="breach"></div>' +
        '<ul class="policy" id="policy"></ul>' +
        '<p class="ss-note">This demo checks passwords against the live Have I Been Pwned corpus ' +
          'using its k-anonymity range API — only a 5-character hash prefix is sent, never your ' +
          'password. The product itself runs this check against a fully offline local copy.</p>' +
      '</div>' +
      '<div class="ss-field"><label>Confirm new password</label>' +
        '<input class="ss-input" id="pw2" type="password"></div>';
  }

  // Wires the live policy meter + submit gating. `fixedUser` skips the picker
  // (used when the user was already chosen in an earlier step).
  function wirePasswordFields(onSubmit, fixedUser) {
    var pw = document.getElementById('pw');
    var pw2 = document.getElementById('pw2');
    var submit = document.getElementById('submit');
    var meter = document.getElementById('meter');
    var label = document.getElementById('pw-label');
    var breach = document.getElementById('breach');
    var policy = document.getElementById('policy');
    var LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
    // Cache of corpus hits keyed by password value, plus a request token so a
    // slow lookup for an old keystroke can't clobber a newer one.
    var breachCache = Object.create(null);
    var breachReqId = 0;

    function refresh() {
      var val = pw.value;
      var res = Demo.checkPassword(val, breachCache[val]);
      meter.className = 'pw-meter s' + res.score;
      label.textContent = val ? LABELS[res.score] : 'Enter a password';
      policy.innerHTML = res.rules.map(function (r) {
        return '<li class="' + (r.ok ? 'ok' : 'bad') + '"><span class="mark">' +
          (r.ok ? '&#10003;' : '&#9675;') + '</span>' + r.label + '</li>';
      }).join('');
      breach.innerHTML = res.breachCount
        ? '<div class="breach-warn">&#9888; This password was found in <strong>' +
            res.breachCount.toLocaleString() + '</strong> known breaches and is blocked.</div>'
        : '';
      var match = val.length > 0 && val === pw2.value;
      submit.disabled = !(res.ok && match);

      // Authoritative check against the live breach corpus (HIBP k-anonymity).
      // Only run once per distinct value; re-render if it surfaces a new hit.
      if (val && !(val in breachCache)) {
        var myId = ++breachReqId;
        Demo.breachLookup(val).then(function (count) {
          if (myId !== breachReqId || count == null) return; // stale or unreachable
          breachCache[val] = count;
          if (count > 0 && pw.value === val) refresh();
        });
      }
    }
    pw.addEventListener('input', refresh);
    pw2.addEventListener('input', refresh);
    refresh();

    submit.addEventListener('click', function () {
      var who = fixedUser || (document.getElementById('who') && document.getElementById('who').value);
      onSubmit(who);
    });
  }

  function successScreen(username, title, sub) {
    var u = Demo.getUser(state, username);
    viewEl.innerHTML =
      '<div class="ss-success"><div class="big">&#9989;</div>' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>' + esc(sub) + '</p>' +
        '<p style="margin-top:0.5rem; font-size:0.85rem;">Account: <strong>' + esc(u.email) + '</strong></p>' +
      '</div>' +
      '<a class="btn-ss" href="admin.html" style="margin-bottom:0.6rem; text-decoration:none;">See it in the Admin Console &rarr;</a>' +
      '<button class="btn-ss ghost" id="again">Back to portal home</button>';
    toast('Sandbox updated — visible in Admin & Helpdesk');
    document.getElementById('again').addEventListener('click', viewHome);
  }

  function backBtn() { return '<button class="ss-back" id="back">&larr; Back</button>'; }
  function bindBack() {
    var b = document.getElementById('back');
    if (b) b.addEventListener('click', viewHome);
  }

  function render(view) {
    state = Demo.load(); // re-read in case another tab changed it
    switch (view) {
      case 'reset':  return viewReset();
      case 'change': return viewChange();
      case 'unlock': return viewUnlock();
      case 'mfa':    return viewMfa();
      default:       return viewHome();
    }
  }

  render('home');
})();
