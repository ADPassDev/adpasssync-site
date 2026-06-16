// ADPassSync interactive demo — shared sandbox engine.
//
// Everything in the "Try it Live" demo is simulated entirely in the browser.
// No real directory is ever touched; no request leaves the page. State lives in
// localStorage so the three demo surfaces (Self-Service, Admin, Helpdesk) share
// one consistent world: a reset done on the Self-Service page shows up in the
// Admin activity feed. State auto-expires after a TTL and can be wiped from the
// landing page, so every visitor effectively gets a fresh sandbox.
(function () {
  'use strict';

  const KEY = 'adps_demo_v1';
  const TTL_MS = 30 * 60 * 1000; // 30 minutes
  const DOMAIN = 'acme.local';

  // Throwaway logins handed out on the landing page. Accepted as-is by the
  // Admin and Helpdesk sign-in screens (any of the listed creds work).
  const CREDS = {
    admin: { user: 'admin@acme.local', pass: 'Demo-Admin-2026' },
    helpdesk: { user: 'helpdesk@acme.local', pass: 'Demo-Help-2026' },
  };

  // The user the landing page nudges visitors to try first.
  const SUGGESTED = 'jchen';

  // A tiny stand-in for the breached-password corpus. The real product checks
  // 2B+ HIBP hashes; here we just flag a handful of obvious ones plus anything
  // that looks like "Password..." / "Welcome..." so the breach check visibly
  // fires during the demo.
  const BREACHED = new Set([
    'password', 'password1', 'password123', 'p@ssw0rd', 'qwerty',
    'letmein', 'welcome', 'welcome1', 'admin', 'changeme', 'abc123',
    'iloveyou', 'monkey', 'dragon', 'sunshine', 'summer2025', 'acme123',
  ]);

  function seedUsers() {
    // ts offsets (minutes ago) keep the activity feed looking lived-in.
    return [
      { username: 'jchen', name: 'Jane Chen',   ou: 'Sales',   status: 'locked', mfa: true,  pwAgeDays: 88, lastEvent: 14 },
      { username: 'skane', name: 'Sara Kane',   ou: 'Finance', status: 'active', mfa: true,  pwAgeDays: 12, lastEvent: 2 },
      { username: 'mross', name: 'Mike Ross',   ou: 'IT',      status: 'active', mfa: false, pwAgeDays: 41, lastEvent: 33 },
      { username: 'twebb', name: 'Tom Webb',    ou: 'Sales',   status: 'active', mfa: true,  pwAgeDays: 86, lastEvent: 51 },
      { username: 'lpark', name: 'Lisa Park',   ou: 'Finance', status: 'locked', mfa: false, pwAgeDays: 5,  lastEvent: 73 },
      { username: 'dgomez', name: 'Diego Gomez', ou: 'IT',     status: 'active', mfa: true,  pwAgeDays: 23, lastEvent: 120 },
    ].map((u) => ({
      ...u,
      email: u.username + '@' + DOMAIN,
      initials: u.name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase(),
    }));
  }

  function seedEvents(now) {
    const u = (m) => now - m * 60 * 1000;
    return [
      { ts: u(2),  actor: 'skane', action: 'reset',      target: 'skane', detail: 'Self-service reset (MFA verified)' },
      { ts: u(14), actor: 'jchen', action: 'lock',       target: 'jchen', detail: 'Account locked after 5 failed logins' },
      { ts: u(33), actor: 'mross', action: 'reset',      target: 'mross', detail: 'Self-service reset (MFA verified)' },
      { ts: u(51), actor: 'helpdesk', action: 'unlock',  target: 'twebb', detail: 'Unlocked by helpdesk' },
      { ts: u(64), actor: 'jchen', action: 'breach_block', target: 'jchen', detail: 'Blocked: password found in 1 known breach' },
      { ts: u(73), actor: 'lpark', action: 'lock',       target: 'lpark', detail: 'Account locked after 5 failed logins' },
    ];
  }

  function freshState(now) {
    return {
      createdAt: now,
      expiresAt: now + TTL_MS,
      users: seedUsers(),
      events: seedEvents(now),
      // Baseline counters so the dashboard isn't empty; live actions add to them.
      baseline: { resets30d: 1284, breachesBlocked: 312, mfaEnrolled: 0 },
    };
  }

  function nowMs() {
    return new Date().getTime();
  }

  function load() {
    const now = nowMs();
    let state = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) state = JSON.parse(raw);
    } catch (e) {
      state = null;
    }
    if (!state || !state.expiresAt || state.expiresAt < now) {
      state = freshState(now);
      save(state);
    }
    return state;
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* storage disabled — demo still works for the current page in memory */
    }
  }

  function reset() {
    const state = freshState(nowMs());
    save(state);
    return state;
  }

  function touch(state) {
    // Sliding expiry: any interaction extends the sandbox.
    state.expiresAt = nowMs() + TTL_MS;
    save(state);
  }

  function getUser(state, username) {
    return state.users.find((u) => u.username === username) || null;
  }

  function findUsers(state, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return state.users.slice();
    return state.users.filter(
      (u) =>
        u.username.includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }

  function logEvent(state, evt) {
    state.events.unshift({ ts: nowMs(), ...evt });
    state.events = state.events.slice(0, 50);
  }

  // Mutations return the updated state (already saved).
  function resetPassword(state, username, opts) {
    const u = getUser(state, username);
    if (!u) return state;
    u.status = 'active';
    u.pwAgeDays = 0;
    state.baseline.resets30d += 1;
    logEvent(state, {
      actor: (opts && opts.actor) || username,
      action: 'reset',
      target: username,
      detail: (opts && opts.detail) || 'Self-service reset (MFA verified)',
    });
    touch(state);
    return state;
  }

  function unlockAccount(state, username, opts) {
    const u = getUser(state, username);
    if (!u) return state;
    u.status = 'active';
    logEvent(state, {
      actor: (opts && opts.actor) || username,
      action: 'unlock',
      target: username,
      detail: (opts && opts.detail) || 'Account unlocked',
    });
    touch(state);
    return state;
  }

  function enrollMfa(state, username, opts) {
    const u = getUser(state, username);
    if (!u) return state;
    const was = u.mfa;
    u.mfa = true;
    if (!was) state.baseline.mfaEnrolled += 1;
    logEvent(state, {
      actor: (opts && opts.actor) || username,
      action: 'mfa_enroll',
      target: username,
      detail: (opts && opts.detail) || 'Enrolled a second factor (WebAuthn)',
    });
    touch(state);
    return state;
  }

  function recordBreachBlock(state, username) {
    state.baseline.breachesBlocked += 1;
    logEvent(state, {
      actor: username,
      action: 'breach_block',
      target: username,
      detail: 'Blocked: password found in a known breach',
    });
    touch(state);
    return state;
  }

  // Password policy mirrors the product's defaults: length + character classes
  // + a breach check. Returns rule results, a 0-4 strength score, and the
  // number of breaches the password appears in. `knownBreachCount` lets the
  // caller fold in an authoritative hit from the live corpus (see breachLookup).
  function checkPassword(pw, knownBreachCount) {
    pw = pw || '';
    const rules = [
      { label: 'At least 12 characters', ok: pw.length >= 12 },
      { label: 'Upper & lower case letters', ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
      { label: 'At least one number', ok: /[0-9]/.test(pw) },
      { label: 'At least one symbol', ok: /[^A-Za-z0-9]/.test(pw) },
    ];
    const breachCount = Math.max(breachHits(pw), knownBreachCount || 0);
    rules.push({ label: 'Not found in any known breach', ok: pw.length > 0 && breachCount === 0 });

    const met = rules.filter((r) => r.ok).length;
    const score = Math.max(0, Math.min(4, met - 1)); // 0..4
    return {
      rules,
      score,
      breachCount,
      ok: rules.every((r) => r.ok),
    };
  }

  // Instant, fully-offline pre-check against a tiny built-in list so the most
  // obvious passwords fire before any network round-trip.
  function breachHits(pw) {
    const lower = pw.toLowerCase();
    if (BREACHED.has(lower)) return 1 + (lower.charCodeAt(0) % 9) * 137; // pseudo "found in N breaches"
    if (/^(password|welcome|admin|acme|qwerty)/i.test(pw) && pw.length < 14) return 3;
    return 0;
  }

  function sha1Hex(str) {
    return crypto.subtle
      .digest('SHA-1', new TextEncoder().encode(str))
      .then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      );
  }

  // Authoritative breach check against Have I Been Pwned's Pwned Passwords
  // corpus (~900M+ real leaked passwords) using its k-anonymity range API:
  // we SHA-1 the password and send only the first 5 hex chars of the hash.
  // The password and its full hash never leave the browser. Resolves to the
  // number of times the password appears in known breaches, or null if the
  // corpus can't be reached (caller then falls back to the offline pre-check).
  function breachLookup(pw) {
    pw = pw || '';
    if (!pw) return Promise.resolve(0);
    const local = breachHits(pw);
    if (local) return Promise.resolve(local);
    if (!(window.crypto && crypto.subtle && window.fetch)) return Promise.resolve(null);
    return sha1Hex(pw)
      .then((hash) => {
        const upper = hash.toUpperCase();
        const prefix = upper.slice(0, 5);
        const suffix = upper.slice(5);
        return fetch('https://api.pwnedpasswords.com/range/' + prefix, {
          headers: { 'Add-Padding': 'true' },
        }).then((resp) => {
          if (!resp.ok) return null;
          return resp.text().then((text) => {
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const parts = lines[i].split(':');
              if (parts[0] && parts[0].trim().toUpperCase() === suffix) {
                const n = parseInt(parts[1], 10);
                return n > 0 ? n : 0; // padded decoys report a count of 0
              }
            }
            return 0;
          });
        });
      })
      .catch(() => null);
  }

  function generateOtp(seed) {
    // Deterministic 6-digit code so the UI can both display and verify it
    // without any real TOTP. Re-rolls when `seed` changes.
    let h = 0;
    const s = String(seed || nowMs());
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000;
    return String(h).padStart(6, '0');
  }

  function fmtAgo(ts) {
    const diff = Math.max(0, nowMs() - ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  window.Demo = {
    DOMAIN,
    CREDS,
    SUGGESTED,
    load,
    save,
    reset,
    touch,
    getUser,
    findUsers,
    logEvent,
    resetPassword,
    unlockAccount,
    enrollMfa,
    recordBreachBlock,
    checkPassword,
    breachLookup,
    generateOtp,
    fmtAgo,
  };
})();
