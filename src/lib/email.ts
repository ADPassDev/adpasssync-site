// Transactional email. Resend if RESEND_API_KEY is configured, otherwise
// a noop in dev (the magic link is also returned to the caller when
// DEV_RETURN_MAGIC_LINK is "true", so login still works locally).

import type { Env } from '../types';

export type SendResult = { sent: boolean; provider: 'resend' | 'noop' };

export async function sendMagicLinkEmail(
  env: Env,
  to: string,
  link: string,
): Promise<SendResult> {
  const subject = 'Sign in to ADPassSync';
  const text =
    `Click the link below to sign in to your ADPassSync portal.\n\n` +
    `${link}\n\n` +
    `This link expires in ${env.MAGIC_LINK_TTL_MINUTES} minutes and ` +
    `can only be used once. If you didn't request it, you can ignore this email.`;
  const html = renderMagicLinkHtml(link, env.MAGIC_LINK_TTL_MINUTES);

  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('resend send failed', res.status, body);
      throw new Error(`email send failed: ${res.status}`);
    }
    return { sent: true, provider: 'resend' };
  }

  console.log(`[dev] magic link for ${to}: ${link}`);
  return { sent: false, provider: 'noop' };
}

function renderMagicLinkHtml(link: string, ttlMinutes: string): string {
  // Minimal email-safe HTML. No external resources.
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;
                   background:#f6f7fb;margin:0;padding:32px;color:#0f172a">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;
        background:#ffffff;border-radius:12px;padding:32px;
        box-shadow:0 1px 2px rgba(15,23,42,0.06)">
    <tr><td>
      <h1 style="font-size:20px;margin:0 0 16px">Sign in to ADPassSync</h1>
      <p style="margin:0 0 24px;line-height:1.5">
        Click the button below to sign in to your customer portal.
      </p>
      <p style="margin:0 0 24px">
        <a href="${safeLink}"
           style="display:inline-block;background:#3b82f6;color:#ffffff;
                  padding:12px 20px;border-radius:8px;font-weight:600;
                  text-decoration:none">Sign in</a>
      </p>
      <p style="margin:0 0 8px;color:#475569;font-size:13px">
        Or paste this URL into your browser:
      </p>
      <p style="margin:0 0 24px;word-break:break-all;font-size:13px">
        <a href="${safeLink}" style="color:#3b82f6">${safeLink}</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:12px">
        This link expires in ${ttlMinutes} minutes and can only be used once.
        If you didn't request it, you can ignore this email.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isValidEmail(input: string): boolean {
  // Pragmatic check — RFC-compliant validation isn't worth the bytes.
  if (input.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
