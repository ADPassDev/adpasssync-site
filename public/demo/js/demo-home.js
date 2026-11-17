// Demo landing page. Fills in the suggested first step and the demo logins from
// the shared sandbox, and wires the "Reset now" link in the ribbon. Kept out of
// index.html because the site CSP (script-src 'self') blocks inline scripts.
(function () {
  'use strict';
  var state = Demo.load();
  var sug = Demo.getUser(state, Demo.SUGGESTED);
  var txt = document.getElementById('suggest-text');
  if (sug) {
    txt.innerHTML =
      'Open the <strong>Self-Service Portal</strong> and reset <strong>' + sug.name +
      '</strong> (<span class="mono">' + sug.email + '</span>) — her account is currently <strong>locked</strong>. ' +
      'Then open the <strong>Admin Console</strong> to watch the reset appear in the activity feed.';
  }
  document.getElementById('cred-admin').textContent = Demo.CREDS.admin.user + '  /  ' + Demo.CREDS.admin.pass;
  document.getElementById('cred-help').textContent = Demo.CREDS.helpdesk.user + '  /  ' + Demo.CREDS.helpdesk.pass;

  document.getElementById('reset-sandbox').addEventListener('click', function (e) {
    e.preventDefault();
    Demo.reset();
    location.reload();
  });
})();
