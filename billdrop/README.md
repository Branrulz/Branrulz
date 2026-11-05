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
  | Bronze | $100+ |
  | Silver | $1,000+ |
  | Gold | $5,000+ |
  | Platinum | $25,000+ |
  | Black Card | $100,000+ |

  Shown as a membership card, chips on the leaderboard, and progress to the next tier.
- **Paperwork, handled**: a receipt for every payment, an annual statement, a CSV for the accountant, and a live gift-tax note before paying.
- **Verification**: required statement, human review, duplicate detection, reports and bans.
- **Identity protection**: first name only, no contact or ID details allowed in public text, statements deleted after review, no patron-to-member messaging.
- Black-and-gold "private members' club" look, works on phones.

See **[TRUST.md](TRUST.md)** for the full fraud, identity-theft and tax write-up, including what's still needed before launch.

## ⚠️ Prototype: payments are simulated

"Settle" records the payment, but no money moves. Before launch: real payments (e.g. Stripe), payouts to billers through bill-pay rails, ID verification for members and patrons, a real database, and a legal/CPA review. The details are in TRUST.md.

## API (summary)

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | anyone |
| GET | `/api/me` | anyone |
| GET | `/api/bills?status=open\|paid\|all&category=&sort=` · `/api/deck` · `/api/stats` | anyone |
| POST | `/api/bills` (with statement) · GET `/api/my/bills` | member |
| POST | `/api/bills/:id/pay` · `/api/bills/:id/pass` · `/api/deck/reset` | patron |
| GET | `/api/bills/:id/tax-preview` · `/api/my/giving` · `/api/my/tax?year=` · `/api/my/tax.csv?year=` · `/api/my/receipts/:id` | patron |
| POST | `/api/bills/:id/report` | signed in |
| GET | `/api/admin/queue` · `/api/admin/bills/:id/document` · POST `/api/admin/bills/:id/review` | reviewer |
