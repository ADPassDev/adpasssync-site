// Transactional email. Resend if RESEND_API_KEY is configured, otherwise
// a noop in dev (the magic link is also returned to the caller when
// DEV_RETURN_MAGIC_LINK is "true", so login still works locally).

import type { Customer, Env, Purchase } from '../types';

export type SendResult = { sent: boolean; provider: 'resend' | 'noop' };

type EmailMessage = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

async function sendViaResend(env: Env, msg: EmailMessage): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, provider: 'noop' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('resend send failed', res.status, body);
    throw new Error(`email send failed: ${res.status}`);
  }
  return { sent: true, provider: 'resend' };
}

function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

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
    return sendViaResend(env, { to, subject, text, html });
  }
  console.log(`[dev] magic link for ${to}: ${link}`);
  return { sent: false, provider: 'noop' };
}

/**
 * Notify each address in env.PURCHASE_NOTIFY_EMAILS that a customer submitted
 * a quote request. Deliberately not ADMIN_EMAILS: that is the portal admin
 * identity (see isAdminEmail) and need not be a deliverable mailbox.
 *
 * Best-effort — caller should wrap in waitUntil so a flaky email provider
 * doesn't fail the user-facing request.
 */
export async function sendPurchaseAlertEmail(
  env: Env,
  purchase: Purchase,
  customer: Customer,
): Promise<SendResult> {
  const recipients = parseRecipients(env.PURCHASE_NOTIFY_EMAILS);
  if (!recipients.length) {
    console.log('[purchase-alert] PURCHASE_NOTIFY_EMAILS is empty, skipping');
    return { sent: false, provider: 'noop' };
  }

  const subjectTag = customer.company || customer.email;
  const subject = `[ADPassSync] Quote request — ${subjectTag}`;
  const adminLink = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/portal/admin.html`;
  const submittedAt = new Date(purchase.created_at * 1000).toISOString();

  const text = [
    `A new quote request was submitted on adpasssync.com.`,
    ``,
    `Customer:    ${customer.name || '—'} <${customer.email}>`,
    `Company:     ${customer.company || '—'}`,
    `Customer ID: ${customer.id}`,
    ``,
    `Tier:        ${purchase.tier}`,
    `Seats:       ${purchase.seats}`,
    `Submitted:   ${submittedAt}`,
    `Reference:   ${purchase.id}`,
    ``,
    `Notes:`,
    purchase.notes ? purchase.notes : '(none)',
    ``,
    `Triage in the admin portal: ${adminLink}`,
    ``,
  ].join('\n');

  const html = renderPurchaseAlertHtml({
    customerEmail: customer.email,
    customerName: customer.name,
    customerCompany: customer.company,
    customerId: customer.id,
    tier: purchase.tier,
    seats: purchase.seats,
    notes: purchase.notes,
    submittedAt,
    referenceId: purchase.id,
    adminLink,
  });

  if (env.RESEND_API_KEY) {
    return sendViaResend(env, { to: recipients, subject, text, html });
  }
  console.log('[dev] purchase alert (no RESEND_API_KEY):\n' + text);
  return { sent: false, provider: 'noop' };
}

/**
 * A submission from the public contact form on the marketing site. Every field
 * is attacker-controlled — the route validates and truncates before we get here.
 */
export type ContactSubmission = {
  name: string;
  email: string;
  company: string | null;
  adUsers: string | null;
  interest: string | null;
  message: string | null;
};

/**
 * Notify each address in env.CONTACT_NOTIFY_EMAILS that someone filled in the
 * contact form. Reply-To is the submitter, so replying from the inbox goes
 * straight back to them rather than to the no-reply From address.
 *
 * Best-effort — the caller wraps this in waitUntil so a flaky provider never
 * fails the visitor's request.
 */
export async function sendContactEmail(
  env: Env,
  sub: ContactSubmission,
): Promise<SendResult> {
  const recipients = parseRecipients(env.CONTACT_NOTIFY_EMAILS);
  if (!recipients.length) {
    console.log('[contact] CONTACT_NOTIFY_EMAILS is empty, skipping');
    return { sent: false, provider: 'noop' };
  }

  const subjectTag = sub.company || sub.name || sub.email;
  const subject = `[ADPassSync] Contact — ${subjectTag}`;

  const text = [
    `A new enquiry was submitted through the contact form on adpasssync.com.`,
    ``,
    `Name:      ${sub.name}`,
    `Email:     ${sub.email}`,
    `Company:   ${sub.company || '—'}`,
    `AD users:  ${sub.adUsers || '—'}`,
    `Interest:  ${sub.interest || '—'}`,
    ``,
    `Message:`,
    sub.message ? sub.message : '(none)',
    ``,
    `Reply directly to this email to reach ${sub.email}.`,
    ``,
  ].join('\n');

  const html = renderContactHtml(sub);

  if (env.RESEND_API_KEY) {
    return sendViaResend(env, {
      to: recipients,
      subject,
      text,
      html,
      replyTo: sub.email,
    });
  }
  console.log('[dev] contact form (no RESEND_API_KEY):\n' + text);
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

type PurchaseAlertView = {
  customerEmail: string;
  customerName: string | null;
  customerCompany: string | null;
  customerId: string;
  tier: string;
  seats: number;
  notes: string | null;
  submittedAt: string;
  referenceId: string;
  adminLink: string;
};

function renderPurchaseAlertHtml(v: PurchaseAlertView): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;font-size:13px">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 0;color:#0f172a;font-size:14px">${escapeHtml(value)}</td></tr>`;
  const safeNotes = v.notes
    ? `<p style="margin:0 0 16px;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5">${escapeHtml(v.notes)}</p>`
    : `<p style="margin:0 0 16px;color:#94a3b8;font-size:14px">(no notes)</p>`;
  const safeLink = escapeHtml(v.adminLink);
  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;
                   background:#f6f7fb;margin:0;padding:32px;color:#0f172a">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;
        background:#ffffff;border-radius:12px;padding:32px;
        box-shadow:0 1px 2px rgba(15,23,42,0.06)">
    <tr><td>
      <h1 style="font-size:18px;margin:0 0 8px">New quote request</h1>
      <p style="margin:0 0 20px;color:#475569;font-size:14px">
        A customer submitted a quote request on adpasssync.com.
      </p>
      <table role="presentation" style="border-collapse:collapse;margin:0 0 20px">
        ${row('Customer', `${v.customerName || '—'} <${v.customerEmail}>`)}
        ${row('Company', v.customerCompany || '—')}
        ${row('Tier', v.tier)}
        ${row('Seats', String(v.seats))}
        ${row('Submitted', v.submittedAt)}
        ${row('Customer ID', v.customerId)}
        ${row('Reference', v.referenceId)}
      </table>
      <h2 style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Notes</h2>
      ${safeNotes}
      <p style="margin:0">
        <a href="${safeLink}"
           style="display:inline-block;background:#3b82f6;color:#ffffff;
                  padding:10px 18px;border-radius:8px;font-weight:600;
                  text-decoration:none;font-size:14px">Open admin portal</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function renderContactHtml(v: ContactSubmission): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;font-size:13px">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 0;color:#0f172a;font-size:14px">${escapeHtml(value)}</td></tr>`;
  const safeMessage = v.message
    ? `<p style="margin:0 0 16px;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5">${escapeHtml(v.message)}</p>`
    : `<p style="margin:0 0 16px;color:#94a3b8;font-size:14px">(no message)</p>`;
  const safeEmail = escapeHtml(v.email);
  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;
                   background:#f6f7fb;margin:0;padding:32px;color:#0f172a">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;
        background:#ffffff;border-radius:12px;padding:32px;
        box-shadow:0 1px 2px rgba(15,23,42,0.06)">
    <tr><td>
      <h1 style="font-size:18px;margin:0 0 8px">New contact enquiry</h1>
      <p style="margin:0 0 20px;color:#475569;font-size:14px">
        Someone submitted the contact form on adpasssync.com.
      </p>
      <table role="presentation" style="border-collapse:collapse;margin:0 0 20px">
        ${row('Name', v.name)}
        ${row('Email', v.email)}
        ${row('Company', v.company || '—')}
        ${row('AD users', v.adUsers || '—')}
        ${row('Interest', v.interest || '—')}
      </table>
      <h2 style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Message</h2>
      ${safeMessage}
      <p style="margin:0">
        <a href="mailto:${safeEmail}"
           style="display:inline-block;background:#3b82f6;color:#ffffff;
                  padding:10px 18px;border-radius:8px;font-weight:600;
                  text-decoration:none;font-size:14px">Reply to ${safeEmail}</a>
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
