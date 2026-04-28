// ADPassSync site Worker.
//
// Routing model:
//   /api/*   -> Hono Worker (this file)
//   anything else -> Cloudflare static assets (public/), configured in
//                    wrangler.jsonc. Static assets win the race; the Worker
//                    only sees /api/* due to `assets.run_worker_first`.

import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { loadSession, requireAdmin, requireAuth } from './lib/auth';
import authRoutes from './routes/auth';
import portalRoutes from './routes/portal';
import adminRoutes from './routes/admin';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Lightweight health check — useful for uptime probes and to confirm the
// Worker is what's responding (vs. a static 404 from the assets serving).
app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'adpasssync-site', ts: Date.now() }),
);

// Public-key endpoint. Lets the installer (or anyone) fetch the verification
// key for license signatures. Safe to expose — it's a public key.
app.get('/api/public-key', (c) => {
  const key = c.env.LICENSE_PUBLIC_KEY;
  if (!key) return c.json({ error: 'not_configured' }, 503);
  return new Response(key, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-pem-file',
      'Cache-Control': 'public, max-age=300',
    },
  });
});

// Attach session (if any) to every /api request.
app.use('/api/*', loadSession);

// Authentication endpoints (no auth required).
app.route('/api/auth', authRoutes);

// Customer portal — must be signed in.
const portalApp = new Hono<{ Bindings: Env; Variables: Variables }>();
portalApp.use('*', requireAuth);
portalApp.route('/', portalRoutes);
app.route('/api/portal', portalApp);

// Admin — must be signed in *and* have an admin email.
const adminApp = new Hono<{ Bindings: Env; Variables: Variables }>();
adminApp.use('*', requireAdmin);
adminApp.route('/', adminRoutes);
app.route('/api/admin', adminApp);

// JSON 404 for any unmatched /api path. Non-/api paths never reach the
// Worker (assets handle them), but in case run_worker_first changes:
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'not_found' }, 404);
  }
  // Fall through to assets.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error('unhandled', err);
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
