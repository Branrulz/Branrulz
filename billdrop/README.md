# BillDrop

**A private ledger of real bills, settled by patrons of considerable means.**

People who need help (**members**) submit a bill along with their statement. A reviewer checks it before it goes live. Wealthy **patrons** swipe through verified bills and settle them, and the money goes **directly to the biller**, never to an individual. Patrons climb tiers from Bronze to Black Card and get their tax paperwork prepared automatically.

## Run it

```bash
cd billdrop
ADMIN_EMAILS=you@example.com npm start    # http://localhost:3000
npm test
```

No dependencies, just Node 18+. Data lives in `billdrop/data/` (created and seeded with sample bills on first run; delete the folder to reset). Signing up with an email listed in `ADMIN_EMAILS` gives you a **reviewer** account.

| Env var | Purpose |
| --- | --- |
| `ADMIN_EMAILS` | Comma-separated emails that become reviewers on sign-up |
| `PORT` | Default 3000 |
| `DATA_DIR` | Where `db.json` and uploaded statements live |
| `COOKIE_SECURE=1` | Set when serving over HTTPS |
| `AUTH_ATTEMPTS_PER_10_MIN` | Sign-up/login rate limit per IP (default 20) |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | Turns on card payments (test keys only) |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhooks |
| `PAYOUT_HOLD_DAYS` | Days to hold payouts before paying billers (default 7) |
| `ACCOUNT_ENCRYPTION_KEY` | 32-byte base64 key for account numbers (dev: auto-generated in `data/`) |

## Card payments (Stripe test mode)

Without Stripe keys, "Settle" is simulated. With **test** keys, patrons pay by card through Stripe's embedded Payment Element, and no real money moves.

1. Create a free account at [stripe.com](https://stripe.com), stay in **Test mode**, and open **Developers → API keys**.
2. Start BillDrop with your test keys:

   ```bash
   STRIPE_SECRET_KEY=sk_test_... STRIPE_PUBLISHABLE_KEY=pk_test_... ADMIN_EMAILS=you@example.com npm start
   ```

3. Optional but recommended: forward webhooks with the [Stripe CLI](https://docs.stripe.com/stripe-cli), so payments are recorded even if the browser closes mid-payment:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

   Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` and restart.
4. Pay with test cards: `4242 4242 4242 4242` (success), `4000 0000 0000 0002` (declined), `4000 0025 0000 3155` (bank verification pop-up). Use any future date and any CVC.

How a payment works:

1. The patron picks an amount. The settle sheet shows the card total, which includes Stripe's 2.9% + $0.30 fee so the biller receives the full amount.
2. **Continue to payment** creates a PaymentIntent on the server and shows the card form.
3. **Pay** confirms the payment in the browser. The server then **fetches the PaymentIntent from Stripe itself**, checks it succeeded for the right amount, and records the gift exactly once. The webhook does the same if the browser never comes back.
4. If another patron settled the bill first, the extra amount is **refunded automatically**.
5. Each gift adds a **payout to the biller** on the reviewer desk. A reviewer pays the biller (bill-pay, or a check to the biller's official address) and records the check number or confirmation.

Live keys are refused unless `ALLOW_LIVE_PAYMENTS=1`. Don't set that until the launch items in TRUST.md are done.

## Who does what

| | Member | Patron | Reviewer |
| --- | --- | --- | --- |
| Submit a bill (with statement) | ✅ | | |
| Settle a bill | | ✅ | |
| Swipe the Deck | | ✅ | |
| Tiers, membership card, tax documents | | ✅ | |
| Approve / reject / ban | | | ✅ |
| Report a suspicious bill | ✅ | ✅ | |

## Features

- **The Deck**: a swipeable card stack. Swipe right (or press →, or tap ✓) to settle: a confirm sheet opens set to "settle in full", so one more tap pays. Swipe left (←, ✕) to pass; passes are saved and can be reset.
- **Tiers**, based on lifetime giving:

  | Tier | Lifetime giving |
  | --- | --- |
  | Patron | starting tier |
  | Bronze | $1,000+ |
  | Silver | $10,000+ |
  | Gold | $50,000+ |
  | Platinum | $250,000+ |
  | Black Card | $1,000,000+ |

  Shown as a membership card, chips on the leaderboard, and progress to the next tier.
- **Paperwork, handled**: a receipt for every payment, an annual statement, a CSV for the accountant, and a live gift-tax note before paying.
- **Verification**: required statement, human review, duplicate detection, reports and bans.
- **Identity protection**: first name only, no contact or ID details allowed in public text, statements deleted after review, no patron-to-member messaging.
- Black-and-gold "private members' club" look, works on phones.

See **[TRUST.md](TRUST.md)** for the full fraud, identity-theft and tax write-up, including what's still needed before launch.

## Getting money to billers

Bills are owed to thousands of different companies, each with its own portal. BillDrop doesn't integrate with each one. Every biller is put into one of four **payment lanes**:

| Lane | For | Provider (stand-in) | Proof of payment |
| --- | --- | --- | --- |
| Debt payment API | Credit cards, student & auto loans | Method | Lender reports the new balance (automatic) |
| Bill-pay network | Utilities, phone, internet, many hospitals | Mastercard RPPS | No return from the network (automatic) |
| Virtual card | Billers with a guest-pay page | Stripe Issuing | Staff pay on the biller's official site and record the confirmation number |
| Mailed check | Everything else, including landlords | Lob | Check clears (staff), or the member confirms receipt |

- **Biller directory:** members pick their biller from a searchable list (`billers.js`), which sets the lane and checks the account-number format ("Duke Energy account numbers are 12 digits"). A biller that isn't listed can still be submitted, but a reviewer must match it to a directory entry or enter a payment address they've verified themselves before the bill goes live. Unknown billers are paid by check only.
- **Account numbers** are needed in full to pay, so they're stored encrypted (AES-256-GCM, key in `ACCOUNT_ENCRYPTION_KEY`), shown only as `…1234`, and never sent to patrons.
- **Payout lifecycle:** `held` (7-day card-dispute hold, `PAYOUT_HOLD_DAYS`) → `sent` / `needs_agent` → `confirmed`. A payout can also go to `failed`, then **retry by check** or **refund the patron** (through Stripe when it was a card payment). A refund reopens the bill for that amount.
- **Proof:** patrons see "✓ Duke Energy confirmed payment" on the bills they settled and on their receipts. Members see each payment's status and can tap "My biller received it".
- **Reviewer desk → Payouts:** shows what needs a person (virtual-card payments, checks to confirm, failures) and what's on hold or in progress.

The payout providers in `payouts.js` are **simulated**. Each adapter notes the real API it stands in for, so going live means replacing one function per lane.

## ⚠️ Prototype

Card payments run in Stripe **test mode** (or simulated without keys). Paying billers is a manual step that reviewers record. Before taking real money: automated biller payouts (bill-pay API), a licensed partner to hold funds, ID verification for members and patrons, a real database, and a legal/CPA review. The details are in TRUST.md.

## API (summary)

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | anyone |
| GET | `/api/me` | anyone |
| GET | `/api/bills?status=open\|paid\|all&category=&sort=` · `/api/deck` · `/api/stats` | anyone |
| POST | `/api/bills` (with statement) · GET `/api/my/bills` | member |
| GET | `/api/config` | anyone |
| POST | `/api/bills/:id/payment-intent` · `/api/payments/:pi/confirm` (Stripe) or `/api/bills/:id/pay` (simulated) | patron |
| POST | `/api/bills/:id/pass` · `/api/deck/reset` | patron |
| POST | `/api/stripe/webhook` | Stripe (signed) |
| GET | `/api/billers?q=` | anyone |
| POST | `/api/my/bills/:id/confirm-received` | member |
| GET | `/api/admin/payouts` · POST `/api/admin/payouts/process` · POST `/api/admin/payouts/:id/(release\|agent-paid\|confirm\|fail\|retry-check\|refund)` | reviewer |
| GET | `/api/bills/:id/tax-preview` · `/api/my/giving` · `/api/my/tax?year=` · `/api/my/tax.csv?year=` · `/api/my/receipts/:id` | patron |
| POST | `/api/bills/:id/report` | signed in |
| GET | `/api/admin/queue` · `/api/admin/bills/:id/document` · POST `/api/admin/bills/:id/review` | reviewer |
