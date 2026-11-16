# Paddle Billing setup

The portal sells ADPassSync Professional through Paddle Billing (not Paddle
Classic). Set everything up in the Paddle **sandbox** first
(sandbox-vendors.paddle.com, a separate account from live), test it, then
repeat the same steps in the live account.

## How payments become licenses

- Up to 50 active AD users are free and built into the product.
- Past that, customers pay $5 per active AD user per year for **all** their
  users, billed yearly and renewed automatically. The subscription's quantity
  is the license's user count, so the price only allows 51 and up.
- Paddle's webhook is the only thing that grants anything. A customer is
  licensed until the end of the latest billing period a payment covered.
- **Cancelling** stops renewal; the paid term runs to its end.
- An approved **refund** or **chargeback** ends the paid term at once and
  cancels the subscription in Paddle. A reversed chargeback restores it.
- Every change reissues the license for the customer's registered
  installation, keeps their full bloom filter key in step (it's revoked when
  they're back on the free tier), and emails them when they gain or keep a
  paid term.

## 1. Product and price

Catalog > Products > New product: "ADPassSync Professional". Add a price:

- $5.00 USD, recurring every 1 year.
- Quantity: minimum **51**, maximum **100000**. Paddle's default maximum is
  100, which would stop larger customers buying.
- Tax category: whichever Paddle says fits subscription software.

Put the price ID (`pri_...`) in `PADDLE_PRICE_ID` in `wrangler.jsonc`.

## 2. Checkout settings

- Checkout > Checkout settings > Default payment link:
  `https://adpasssync.com/portal/dashboard`. Paddle needs one before the API
  can create transactions.
- Live account only: My account > Settings > Website approval: add
  `adpasssync.com`.
  Paddle's review checks the site for pricing, terms, privacy and refund
  policies.

## 3. Keys

Both are under My account > Settings > Authentication (Developer tools >
Authentication in Paddle's older dashboard layout). Sandbox client-side tokens
start with `test_` and sandbox API keys contain `_sdbx`; if you see a Vendor
ID and auth code instead, that's Paddle Classic, which this integration
doesn't use.

- Client-side tokens tab: create one and put it in `PADDLE_CLIENT_TOKEN` in
  `wrangler.jsonc` (it's public by design).
- API keys tab: create one allowed to read and write customers, write
  transactions, read and write subscriptions, and write customer portal
  sessions. If you give it an expiry date, note it: once the key expires,
  checkout and Manage billing stop working until a new key is stored. Store it
  as a secret:

  ```bash
  npx wrangler secret put PADDLE_API_KEY
  ```

## 4. Notifications

Find Notifications (Developer tools > Notifications in Paddle's older layout;
in the newer one it isn't confirmed here, so check the main menu and My
account > Settings), then New destination. Copy the destination's secret key
when it's created:

- URL: `https://adpasssync.com/api/paddle/webhook`
- Events: `subscription.created`, `subscription.updated`,
  `subscription.activated`, `subscription.canceled`, `subscription.past_due`,
  `subscription.paused`, `subscription.resumed`, `subscription.trialing`,
  `subscription.imported`, `transaction.completed`, `adjustment.created`,
  `adjustment.updated`

Store the destination's secret key:

```bash
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

## 5. Environment

`PADDLE_ENV` in `wrangler.jsonc` is `"sandbox"` while testing and
`"production"` for live. The API key, client-side token and price ID must all
come from that same environment. Until the API key, webhook secret, price ID
and client-side token are all set, the dashboard offers quote requests
instead of checkout. That includes the webhook secret: without it every
payment notification is rejected, so a checkout would take money that never
becomes a license.

While `PADDLE_ENV` is `"sandbox"`, only the accounts listed in
`PADDLE_SANDBOX_TESTERS` can buy. Sandbox checkouts take Paddle's published
test cards, so this stops anyone else getting a paid license for nothing while
the live site is pointed at the sandbox. Everyone else sees quote requests,
and sandbox payments for their accounts grant nothing. Store the list as a
secret, so the addresses stay out of this public repository:

```bash
npx wrangler secret put PADDLE_SANDBOX_TESTERS
```

Enter one or more portal sign-in emails, separated by commas.

## 6. Deploy

The licensing migrations must have run (`npm run db:migrate:remote`; it says
there's nothing to apply once they have). Then:

```bash
npm run deploy
```

Set the secrets before deploying the price ID and client token: until both
are set, purchasing stays off, so the order doesn't matter to customers.

## 7. Test in the sandbox

1. Sign in to the portal with an account listed in `PADDLE_SANDBOX_TESTERS`
   and register an Install ID (any UUID works for this test).
2. Buy 51 or more users with one of Paddle's sandbox test cards.
3. Within a few seconds the Plan card shows Professional, the License card
   offers a `license.json` for that many users, and the full breached-password
   database key appears.
4. Check the browser console on the dashboard for Content-Security-Policy
   errors. `public/_headers` allows Paddle.js from `cdn.paddle.com` and frames
   and connections to `*.paddle.com`; widen it if Paddle.js needs more.
5. Change the user count, then cancel in Manage billing: the plan keeps its
   paid term. Then refund the purchase in the Paddle dashboard: the plan goes
   back to Free and the key stops working.
6. Sign in with an account that isn't a tester: the Plan card offers a quote
   request, not a checkout.

## 8. Go live

Before switching:

- **Product release.** Paid licenses are uploaded on the product's License
  page. Releases up to 0.9.4.0 only accept them after an admin saves
  `https://adpasssync.com/api/public-key` to a file and points
  `license_public_key_path` at it. The next release has the key built in and
  links its License page to the portal.
- **Paddle's website approval** of `adpasssync.com` (Checkout > Website
  approval in the live account). Paddle reviews the site for pricing, terms,
  a privacy policy and a refund policy. The site has pricing and the EULA so
  far.

Then:

1. Finish the sandbox test with the refund (step 7.5), so test accounts are
   back on Free and their keys are revoked.
2. Clear the sandbox records. They name sandbox customers and subscriptions
   that don't exist in the live account, and would break checkout for the
   test accounts:

   ```bash
   npx wrangler d1 execute adpasssync-db --remote --command "DELETE FROM paddle_events; DELETE FROM paddle_subscriptions; DELETE FROM paddle_customers;"
   ```

3. Repeat steps 1 to 4 in the live account: price, default payment link,
   client-side token, API key, notification destination.
4. Store the live API key and the live destination's secret key:

   ```bash
   npx wrangler secret put PADDLE_API_KEY
   ```

   ```bash
   npx wrangler secret put PADDLE_WEBHOOK_SECRET
   ```

5. In `wrangler.jsonc`, set `PADDLE_ENV` to `"production"` and
   `PADDLE_PRICE_ID` and `PADDLE_CLIENT_TOKEN` to the live values, then
   deploy straight away (steps 4 and 5 back to back: in between, the site
   holds live keys with sandbox settings and checkouts fail):

   ```bash
   npm run deploy
   ```

6. Deactivate the sandbox notification destination in the sandbox account,
   and remove the tester list, which production ignores:

   ```bash
   npx wrangler secret delete PADDLE_SANDBOX_TESTERS
   ```
