// Tests for src/lib/paddle-signature.ts and src/lib/billing.ts. Run with `npm test`.
//
// Valid signatures come from Node's crypto.createHmac and from a vector
// computed with the openssl CLI, not from the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaddleSignature } from '../src/lib/paddle-signature.ts';
import {
  MIN_PAID_USERS,
  billingOpenTo,
  paddleConfigured,
  paidTerm,
  parsePaidUsers,
  subscriptionFields,
  type PaddleSubscription,
} from '../src/lib/billing.ts';

const SECRET = 'pdl_ntfset_01test_secret';
const BODY = '{"event_id":"evt_01hv8x","event_type":"subscription.updated"}';
const TS = 1700000000;

function sign(body: string, ts: number, secret = SECRET): string {
  return `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
}

test('accepts the openssl-computed signature', async () => {
  const header = 'ts=1700000000;h1=65b8ac43995399b2111a2806861361a97171986380b9c6aded3b7d40d83b9126';
  assert.deepEqual(await verifyPaddleSignature(BODY, header, SECRET, TS * 1000), { ok: true });
});

test('accepts a fresh signature, also with upper-case hex', async () => {
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS), SECRET, TS * 1000 + 4000)).ok, true);
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS).toUpperCase().replace('TS=', 'ts=').replace('H1=', 'h1='), SECRET, TS * 1000)).ok, true);
});

test('rejects a changed body, the wrong secret, and a missing or malformed header', async () => {
  assert.equal((await verifyPaddleSignature(BODY + ' ', sign(BODY, TS), SECRET, TS * 1000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS, 'other'), SECRET, TS * 1000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, null, SECRET, TS * 1000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, 'ts=1700000000', SECRET, TS * 1000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, 'h1=abc;ts=x', SECRET, TS * 1000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS), '', TS * 1000)).ok, false);
});

test('rejects timestamps more than 5 seconds off, either way', async () => {
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS), SECRET, TS * 1000 + 6000)).ok, false);
  assert.equal((await verifyPaddleSignature(BODY, sign(BODY, TS), SECRET, TS * 1000 - 6000)).ok, false);
});

test('accepts when any one of several h1 values matches (secret rotation)', async () => {
  const good = sign(BODY, TS).split(';')[1]!;
  const header = `ts=${TS};h1=${'0'.repeat(64)};${good}`;
  assert.equal((await verifyPaddleSignature(BODY, header, SECRET, TS * 1000)).ok, true);
});

const PRICE = 'pri_01professional';
function sub(over: Partial<PaddleSubscription> = {}): PaddleSubscription {
  return {
    id: 'sub_01',
    status: 'active',
    customer_id: 'ctm_01',
    items: [{ quantity: 250, recurring: true, status: 'active', price: { id: PRICE } }],
    current_billing_period: { starts_at: '2026-11-16T10:00:00.000000Z', ends_at: '2027-11-16T10:00:00.000000Z' },
    next_billed_at: '2027-11-16T10:00:00.000000Z',
    scheduled_change: null,
    updated_at: '2026-11-16T10:00:01.123456Z',
    ...over,
  };
}

test('an active subscription has paid through the end of its current period', () => {
  const f = subscriptionFields(sub(), PRICE);
  assert.equal(f.quantity, 250);
  assert.equal(f.periodPaidThrough, Date.parse('2027-11-16T10:00:00Z') / 1000);
  assert.equal(f.cancel_at, null);
  assert.equal(f.updated_ms, Date.parse('2026-11-16T10:00:01.123Z'));
});

test('a past_due or canceled subscription extends nothing; a scheduled cancel is recorded', () => {
  assert.equal(subscriptionFields(sub({ status: 'past_due' }), PRICE).periodPaidThrough, null);
  assert.equal(subscriptionFields(sub({ status: 'canceled', current_billing_period: null }), PRICE).periodPaidThrough, null);
  const f = subscriptionFields(sub({ scheduled_change: { action: 'cancel', effective_at: '2027-11-16T10:00:00Z' } }), PRICE);
  assert.equal(f.cancel_at, Date.parse('2027-11-16T10:00:00Z') / 1000);
});

test('the quantity comes from the Professional price item', () => {
  const s = sub({
    items: [
      { quantity: 1, recurring: false, price: { id: 'pri_other' } },
      { quantity: 120, recurring: true, price: { id: PRICE } },
    ],
  });
  assert.equal(subscriptionFields(s, PRICE).quantity, 120);
});

test('paid term: none until a payment completes', () => {
  assert.equal(paidTerm([]), null);
  assert.equal(paidTerm([{ id: 'sub_01', quantity: 250, paid_through: null, refunded_at: null }]), null);
});

test('paid term: runs to the paid-through date; cancelling does not shorten it', () => {
  // Cancellation is not an input at all: only payments and refunds are.
  assert.deepEqual(paidTerm([{ id: 'sub_01', quantity: 250, paid_through: 2000, refunded_at: null }]), {
    tier: 'professional',
    max_users: 250,
    expires_at: 2000,
    source: 'paddle:sub_01',
  });
});

test('paid term: a refund ends it at the refund', () => {
  assert.equal(paidTerm([{ id: 'sub_01', quantity: 250, paid_through: 2000, refunded_at: 1500 }])!.expires_at, 1500);
});

test('paid term: the subscription that runs furthest wins; never below 51 users', () => {
  const t = paidTerm([
    { id: 'sub_old', quantity: 400, paid_through: 1000, refunded_at: null },
    { id: 'sub_new', quantity: 10, paid_through: 3000, refunded_at: null },
  ]);
  assert.deepEqual(t, { tier: 'professional', max_users: MIN_PAID_USERS, expires_at: 3000, source: 'paddle:sub_new' });
});

test('users to buy: whole numbers from 51 to 100,000', () => {
  assert.equal(parsePaidUsers(51), 51);
  assert.equal(parsePaidUsers('250'), 250);
  for (const bad of [50, 0, -1, 51.5, 100001, '', 'abc', null, undefined]) {
    assert.equal(parsePaidUsers(bad), null, String(bad));
  }
});

test('production billing is open to everyone', () => {
  assert.equal(billingOpenTo({ PADDLE_ENV: 'production' }, 'anyone@example.com'), true);
  assert.equal(billingOpenTo({ PADDLE_ENV: 'production', PADDLE_SANDBOX_TESTERS: 'tester@example.com' }, 'anyone@example.com'), true);
});

test('sandbox billing is only for the named testers', () => {
  const env = { PADDLE_ENV: 'sandbox', PADDLE_SANDBOX_TESTERS: ' Tester@Example.com , second@example.com,' };
  assert.equal(billingOpenTo(env, 'tester@example.com'), true, 'case and spaces ignored');
  assert.equal(billingOpenTo(env, 'SECOND@example.com'), true);
  assert.equal(billingOpenTo(env, 'outsider@example.com'), false);
  assert.equal(billingOpenTo(env, ''), false, 'an empty entry matches nobody');
  assert.equal(billingOpenTo(env, 'tester@example.com.evil.test'), false, 'whole addresses only');
});

test('sandbox billing with no testers, or an unknown environment, is closed', () => {
  assert.equal(billingOpenTo({ PADDLE_ENV: 'sandbox' }, 'tester@example.com'), false);
  assert.equal(billingOpenTo({ PADDLE_ENV: 'sandbox', PADDLE_SANDBOX_TESTERS: '' }, 'tester@example.com'), false);
  assert.equal(billingOpenTo({ PADDLE_ENV: 'Production', PADDLE_SANDBOX_TESTERS: '' }, 'tester@example.com'), false);
  assert.equal(billingOpenTo({}, 'tester@example.com'), false);
});

test('purchasing stays off until every Paddle setting is present, the webhook secret included', () => {
  const full = {
    PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
    PADDLE_PRICE_ID: 'pri_x',
    PADDLE_CLIENT_TOKEN: 'test_x',
    PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_x',
  };
  assert.equal(paddleConfigured(full), true);
  for (const name of ['PADDLE_API_KEY', 'PADDLE_PRICE_ID', 'PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET']) {
    assert.equal(paddleConfigured({ ...full, [name]: '' }), false, `${name} empty`);
    assert.equal(paddleConfigured({ ...full, [name]: undefined }), false, `${name} missing`);
  }
});
