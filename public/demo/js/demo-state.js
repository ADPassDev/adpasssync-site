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

  // Password policy mirrors the product's local-policy rules: length + character
  // classes. The breached-password corpus check runs only in the installed
  // product (offline, against a local 2B+ hash database) and is intentionally
  // NOT performed in this online demo, so it isn't part of these results.
  // Returns rule results, a 0-4 strength score, and whether all rules pass.
  function checkPassword(pw) {
    pw = pw || '';
    const rules = [
      { label: 'At least 12 characters', ok: pw.length >= 12 },
      { label: 'Upper & lower case letters', ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
      { label: 'At least one number', ok: /[0-9]/.test(pw) },
      { label: 'At least one symbol', ok: /[^A-Za-z0-9]/.test(pw) },
    ];

    const met = rules.filter((r) => r.ok).length;
    const score = Math.max(0, Math.min(4, met)); // 0..4
    return {
      rules,
      score,
      ok: rules.every((r) => r.ok),
    };
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
    generateOtp,
    fmtAgo,
  };
})();
