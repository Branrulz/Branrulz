# Trust, safety & taxes

BillDrop moves money between strangers, so there are three kinds of attack to plan for:

1. **Fake bills**: someone invents or inflates a bill to get money.
2. **Identity harvesting**: someone signs up as a "patron" to collect personal details from people in debt.
3. **Abuse of patrons**: stolen cards, laundering, or impersonating BillDrop to scam members.

The table below shows what the prototype already enforces in code and what a real launch still needs.

## 1. Fake bills and scams

| Control | Prototype | Notes |
| --- | --- | --- |
| **Money only ever goes to the biller** | ✅ Every contribution records `payee = biller` | This is the most important control. A fake bill can't pay out to a scammer if the payment goes to Duke Energy. |
| Statement required | ✅ PDF/PNG/JPG up to 4 MB, file type checked by its actual bytes | |
| Human review before going live | ✅ Bills start as `pending` and only `verified` bills are public or payable | Reviewers see a checklist and fraud signals. |
| Call the biller to confirm | 📋 Reviewer instruction | Use a phone number you **look up yourself**, never the one printed on the statement (scammers forge those). |
| Duplicate statement | ✅ Same file hash is refused | |
| Same account claimed by two people | ✅ Flagged to the reviewer | Matches on biller name + last 4 digits of the account number. |
| Attestation | ✅ Required checkbox: "this bill is real and mine" | |
| Limits | ✅ $25,000 per bill, 2 open bills per member, 5 submissions/hour | Settings live in `POLICY` in `server.js`. |
| Strikes | ✅ 3 rejected bills means the member can't submit more | |
| Community reports | ✅ 3 reports from different people pull a live bill back into review | |
| Ban | ✅ "Reject & ban" suspends the account, ends its sessions and pulls its open bills | |
| **ID verification of members** | ❌ Needed for launch | Stripe Identity or Persona. |
| **Pay billers through real bill-pay rails** | ❌ Needed for launch | e.g. Method Financial, a bill-pay API, or a check to the biller's verified remit address. |

## 2. Protecting members' identities

The threat: someone joins as a patron purely to collect names, locations and account details of vulnerable people, then uses them for identity theft or targeted scams ("Hi, I'm from BillDrop, I just need your SSN to release the payment…").

| Control | Prototype |
| --- | --- |
| Patrons see **first name + city/region only** | ✅ Only the first word of the member's name is ever shown |
| Statements, account numbers, emails are **never** shown to patrons | ✅ Kept out of every public and patron API response |
| Statements **deleted after review** | ✅ The file is removed on approve/reject; only its hash is kept, to catch resubmissions |
| Members told to black out SSN, date of birth and full account number before uploading | ✅ On the upload field |
| **No patron-to-member messaging** | ✅ There's no channel for a patron to contact a member |
| Contact details / ID numbers blocked in public text | ✅ Titles, stories, cities, names and patron messages are checked for emails, phone numbers, links, street addresses, SSN-like and long account-like numbers, and "Venmo/CashApp/DM me"-style requests |
| Anti-scraping | ✅ Feed and deck are rate-limited per IP |
| Member safety warning | ✅ On the member dashboard: "No one from BillDrop or any patron will ever contact you…" |
| Patron ID verification (KYC) | ❌ Needed for launch; it also deters harvesters, who don't want to hand over their own ID |

## 3. Protecting patrons and the platform

| Control | Prototype |
| --- | --- |
| Passwords hashed with scrypt; HttpOnly, SameSite=Lax session cookies | ✅ |
| API POSTs must be JSON (blocks cross-site form CSRF) | ✅ |
| Login / sign-up rate limit | ✅ |
| Statement files served to reviewers only, sandboxed, `nosniff` | ✅ |
| Card fraud (stolen cards) | ❌ Needed for launch: Stripe Radar, plus a hold period before paying billers |
| Money laundering via fake bills | ❌ Needed for launch: patron KYC above a threshold, velocity limits, and AML review of large settlements |

## 4. Taxes: what patrons can and can't claim

> Records only, not tax advice. Have a CPA review before launch.

- **Not a charitable deduction.** The IRS doesn't allow a deduction for gifts meant for a specific person, even when routed through a charity ([IRS Pub. 526](https://www.irs.gov/publications/p526)). Because a patron chooses whose bill to pay, BillDrop must **never** call settlements "tax-deductible".
- **Medical bills: unlimited and tax-free.** Paying someone's medical bill **directly to the provider** is excluded from gift tax with no dollar limit and isn't reported on Form 709 ([26 CFR 25.2503-6](https://www.ecfr.gov/current/title-26/chapter-I/subchapter-B/part-25/subject-group-ECFR8f0be246c941b89/section-25.2503-6)). If insurance later reimburses the expense, that portion doesn't qualify.
- **Everything else is a gift** that counts toward the annual exclusion: **$19,000 per recipient in 2026**. Above that, the patron files Form 709 (tax is rarely owed because it draws on the lifetime exemption).

What BillDrop generates for patrons:

- A **receipt** for every payment (receipt number, payer, biller paid, on whose behalf, gift-tax treatment), printable or saveable as PDF.
- An **annual statement** that splits medical from other gifts, with per-recipient totals and a Form 709 warning.
- A **CSV export** for their accountant (protected against spreadsheet formula injection).
- A **live tax note in the settle sheet** showing the treatment and how much they've given that person this year, with a warning before they cross the exclusion.

The figures live in `ANNUAL_EXCLUSION_CENTS` in `server.js` and must be updated each year.

### If you want real tax deductions

Deductibility needs a 501(c)(3) (yours, or a fiscal sponsor / community foundation) running a **needs-based assistance fund** where the *charity*, not the donor, picks who gets helped. That could sit alongside the swipe model as a second option: "Give to the BillDrop Fund (tax-deductible; we choose the bills)". It can't replace picking a specific person.
