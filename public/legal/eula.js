// EULA page: mobile nav menu and table-of-contents toggle. Lives in its own
// file because the site CSP (public/_headers: script-src 'self') blocks inline
// scripts and inline event handlers.
(function () {
  'use strict';

  // Mobile nav menu: behaves like the homepage's. The toggle opens/closes it;
  // tapping a menu link or anywhere outside closes it. The toggle click is not
  // stopped from propagating: the TOC's outside-click handler below must see it,
  // so opening this menu closes the TOC instead of stacking the two panels.
  var navBtn = document.querySelector('.nav-toggle');
  var navLinks = document.querySelector('.nav-links');
  if (navBtn && navLinks) {
    var setNav = function (open) {
      navLinks.classList.toggle('open', open);
      navBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    setNav(false);
    navBtn.addEventListener('click', function () {
      setNav(!navLinks.classList.contains('open'));
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setNav(false); });
    });
    document.addEventListener('click', function (e) {
      if (navLinks.classList.contains('open') && !navLinks.contains(e.target) && !navBtn.contains(e.target)) setNav(false);
    });
  }

  // Table of contents: the toggle flips .open and aria-expanded together.
  // Closes on a TOC link click, a click outside, or Escape.
  var toc = document.querySelector('.toc');
  var tocBtn = document.querySelector('.toc-toggle');
  if (toc && tocBtn) {
    var setToc = function (open) {
      toc.classList.toggle('open', open);
      tocBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    tocBtn.addEventListener('click', function () {
      setToc(!toc.classList.contains('open'));
    });
    toc.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setToc(false); });
    });
    document.addEventListener('click', function (e) {
      if (toc.classList.contains('open') && !toc.contains(e.target) && !tocBtn.contains(e.target)) setToc(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toc.classList.contains('open')) setToc(false);
    });
  }
})();
