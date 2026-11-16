// Legal pages behaviour: table-of-contents flyout and the mobile nav toggle.
//
// External rather than inline because the CSP in public/_headers sets
// script-src 'self', which blocks both inline <script> bodies and inline
// on* handler attributes. Both toggles previously lived in onclick
// attributes on the buttons and so never fired in production.

(function () {
    var toc = document.querySelector('.toc');
    var btn = document.querySelector('.toc-toggle');
    if (!toc || !btn) return;

    function close() {
        toc.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = toc.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    toc.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', close);
    });
    document.addEventListener('click', function (e) {
        if (toc.classList.contains('open') && !toc.contains(e.target) && !btn.contains(e.target)) {
            close();
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
    });
})();

(function () {
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        links.classList.toggle('open');
    });
    links.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { links.classList.remove('open'); });
    });
    document.addEventListener('click', function (e) {
        if (!links.contains(e.target) && !toggle.contains(e.target)) {
            links.classList.remove('open');
        }
    });
})();
