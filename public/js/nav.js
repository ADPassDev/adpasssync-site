// Mobile nav toggle for the homepage. Lives in its own file because the site
// CSP (public/_headers: script-src 'self') blocks inline scripts.
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
