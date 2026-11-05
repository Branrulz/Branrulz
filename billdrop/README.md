# 💸 BillDrop

**Post your bills. Bored billionaires pay them off.**

People post a bill or debt (medical, rent, student loan, utilities, etc.) along with who it's owed to.
Wealthy patrons browse the feed, chip in or pay a bill in full, and get a spot on the leaderboard.

## Run it

```bash
cd billdrop
npm start          # http://localhost:3000
npm test
```

No dependencies — just Node 18+. Data lives in `billdrop/data/db.json` (created and seeded with sample bills on first run; delete it to reset).

## Features

- Post a bill: title, story, amount, category, biller, first name, city, optional due date
- Feed with tabs (Open / Paid off / All), category filter, and sorting (newest, due soonest, smallest left, closest to done)
- Pay part of a bill or "just pay the whole thing", with an optional name and message
- Progress bars, "PAID OFF" stamp, site-wide totals, and a top-patrons leaderboard
- Works on phones, supports dark mode

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/bills?status=open\|paid\|all&category=&sort=` | |
| POST | `/api/bills` | `title, story, amount, category, biller, name, city?, dueDate?` |
| GET | `/api/bills/:id` | |
| POST | `/api/bills/:id/pay` | `amount` or `payInFull: true`, `patron?`, `message?` |
| GET | `/api/stats` | |
| GET | `/api/categories` | |

## ⚠️ This is a prototype — payments are simulated

Clicking "Pay" records a pledge; no money moves. Before this goes live it needs:

1. **Real payments** — e.g. Stripe Checkout for patrons. Ideally pay the **biller directly** (or via a bill-pay service) rather than sending cash to the poster, which cuts down on scams.
2. **Bill verification** — require an uploaded statement / account number and have someone (or a service) confirm it before a bill goes public.
3. **Accounts & moderation** — logins for posters and patrons, reporting, rate limiting, and admin review.
4. **A real database** — swap the JSON file for SQLite/Postgres.
5. **Legal check** — money transmission rules, gift-tax and charity implications, and privacy for people sharing debt details.
