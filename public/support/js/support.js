// Support page behaviour: the mobile nav toggle, and the walkthrough's
// chapter links.
//
// External rather than inline because the CSP in public/_headers sets
// script-src 'self', which blocks inline <script> bodies and on* attributes.
//
// Chapter links are plain #t=<seconds> anchors, so they can be copied and
// shared: opening /support/#t=128 cues the video at 2:08. A click seeks and
// plays; the chapter being played is marked with aria-current.

(function () {
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { links.classList.remove('open'); });
    });
    document.addEventListener('click', function (e) {
        if (!links.contains(e.target) && !toggle.contains(e.target)) {
            links.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
})();

(function () {
    var video = document.getElementById('walkthrough');
    var section = document.getElementById('installation');
    if (!video || !section) return;
    var chapters = Array.prototype.slice.call(document.querySelectorAll('.chapters a[data-t]'));
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function hashTime() {
        var m = /^#t=(\d{1,5}(?:\.\d+)?)$/.exec(window.location.hash);
        return m ? Number(m[1]) : null;
    }

    // Seeking only works once the duration is known; until then, queue it.
    function seek(t, play) {
        if (video.readyState >= 1) {
            video.currentTime = t;
        } else {
            video.addEventListener('loadedmetadata', function () { video.currentTime = t; }, { once: true });
        }
        if (play) {
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* autoplay refused: leave it cued */ });
        }
    }

    function showPlayer() {
        var r = video.getBoundingClientRect();
        if (r.top < 64 || r.bottom > window.innerHeight) {
            section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        }
    }

    function markCurrent() {
        var t = video.currentTime + 0.25;
        var current = null;
        chapters.forEach(function (a) { if (Number(a.getAttribute('data-t')) <= t) current = a; });
        chapters.forEach(function (a) {
            if (a === current) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
        });
    }
    video.addEventListener('timeupdate', markCurrent);
    video.addEventListener('seeked', markCurrent);

    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[data-t]');
        if (!a) return;
        e.preventDefault();
        var t = Number(a.getAttribute('data-t'));
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', '#t=' + t);
        }
        showPlayer();
        seek(t, true);
    });

    // A shared link to a chapter cues the video there (without playing it:
    // browsers block autoplay with sound).
    var start = hashTime();
    if (start !== null) {
        showPlayer();
        seek(start, false);
    }
    window.addEventListener('hashchange', function () {
        var t = hashTime();
        if (t !== null) { showPlayer(); seek(t, false); }
    });
})();
