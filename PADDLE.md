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
- Live account only: Checkout > Website approval: add `adpasssync.com`.
  Paddle's review checks the site for pricing, terms, privacy and refund
  policies.

## 3. Keys

- Developer tools > Authentication > Client-side tokens: create one and put it
  in `PADDLE_CLIENT_TOKEN` in `wrangler.jsonc` (it's public by design).
- Developer tools > Authentication > API keys: create one allowed to read and
  write customers, write transactions, read and write subscriptions, and
  write customer portal sessions. Store it as a secret:

  ```bash
  npx wrangler secret put PADDLE_API_KEY
  ```

## 4. Notifications

Developer tools > Notifications > New destination:

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
come from that same environment. With `PADDLE_PRICE_ID` or
`PADDLE_CLIENT_TOKEN` empty, the dashboard falls back to quote requests.

## 6. Deploy

```bash
npm run db:migrate:remote
```

```bash
npm run deploy
```

## 7. Test in the sandbox

1. Sign in to the portal with a test account and register any Install ID.
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
