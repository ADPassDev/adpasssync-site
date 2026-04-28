// Portal login: posts an email to /api/auth/login and shows a confirmation
// (or, in dev mode, the magic link inline so you can click straight through).
(function () {
  'use strict';

  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const submitBtn = document.getElementById('submit-btn');
  const alertBox = document.getElementById('alert');
  const devBox = document.getElementById('dev-link');
  const devAnchor = document.getElementById('dev-link-anchor');

  // Surface ?error=... query params from the verify redirect.
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (err === 'expired_link') {
    showAlert('error', 'That sign-in link has expired or already been used. Request a new one.');
  } else if (err === 'invalid_link') {
    showAlert('error', 'That sign-in link was invalid. Please request a new one.');
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    devBox.classList.add('hidden');
    alertBox.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAlert('error', data.error === 'invalid_email'
          ? 'Please enter a valid email address.'
          : 'Something went wrong. Please try again.');
      } else {
        showAlert('success', 'Check your inbox — we\'ve sent you a one-time sign-in link. If you don\'t have an account yet, we\'ll create one when you click it.');
        if (data.dev_link) {
          devAnchor.href = data.dev_link;
          devAnchor.textContent = data.dev_link;
          devBox.classList.remove('hidden');
        }
      }
    } catch (e) {
      showAlert('error', 'Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send sign-in link';
    }
  });

  function showAlert(kind, msg) {
    alertBox.className = 'alert ' + kind;
    alertBox.textContent = msg;
    alertBox.classList.remove('hidden');
  }
})();
