// Marketing site behaviour: mobile nav toggle and the contact form.
// Kept external rather than inline because the CSP in public/_headers
// sets script-src 'self', which blocks inline <script> bodies.

(function(){
  var toggle = document.getElementById('navToggle');
  var links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', links.classList.contains('open'));
  });
  // Close menu when a nav link is tapped
  links.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', function() { links.classList.remove('open'); });
  });
  // Close menu when tapping outside
  document.addEventListener('click', function(e) {
    if (!links.contains(e.target) && e.target !== toggle) {
      links.classList.remove('open');
    }
  });
})();

(function(){
  var form = document.getElementById('contactForm');
  var status = document.getElementById('contactStatus');
  if (!form || !status) return;
  var button = form.querySelector('.form-submit');
  var label = button ? button.innerHTML : '';

  function show(kind, text) {
    status.className = 'form-status show ' + kind;
    status.textContent = text;
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var data = new FormData(form);
    var payload = {
      name: data.get('name') || '',
      email: data.get('email') || '',
      company: data.get('company') || '',
      ad_users: data.get('ad_users') || '',
      interest: data.get('interest') || '',
      message: data.get('message') || '',
      _honey: data.get('_honey') || ''
    };

    if (button) { button.disabled = true; button.innerHTML = 'Sending&hellip;'; }
    status.className = 'form-status';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res.ok) throw new Error('http ' + res.status);
      form.reset();
      show('ok', 'Thanks — your message is on its way. We’ll be in touch shortly.');
    }).catch(function() {
      show('err', 'Sorry, something went wrong sending that. Please email us directly at admin@adpasssync.com.');
    }).then(function() {
      if (button) { button.disabled = false; button.innerHTML = label; }
    });
  });
})();
