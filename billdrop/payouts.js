// Payout providers: one adapter per payment lane.
//
// Every adapter takes a payout plus what it needs to pay (the biller entry and the decrypted account
// number) and returns the next state for that payout. In this prototype all adapters are SIMULATED:
// they return realistic references without calling anyone. Each one notes the real API it stands in
// for, so swapping in a live provider means replacing a single function.
//
// Payout lifecycle:
//   held ──(hold period ends)──▶ dispatched by lane adapter ──▶ sent ──▶ confirmed
//                                         │                      │
//                                         └──▶ needs_agent       └──▶ failed ──▶ retried by check / refunded
//                                              (virtual card: a person pays on the portal)

const crypto = require("node:crypto");

const rand = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join("");
const mask = (acct) => "…" + String(acct).slice(-4);

const adapters = {
  // Real: Method Financial — POST /payments from BillDrop's funding account to the member's
  // liability account (entity + account created via Method's Connect). Method reports the new
  // balance afterwards, which is the proof of payment.
  debt_api({ payout, accountNumber }) {
    return {
      status: "sent", provider: "Method", reference: `mtd_pmt_${rand(6).toLowerCase()}`,
      detail: `Sent to lender for account ${mask(accountNumber)}`, autoConfirm: true,
    };
  },

  // Real: an RPPS originator (e.g. TabaPay, Cross River) — submit a bill payment to the biller's RPPS
  // ID with the account number, after validating it against the biller's account mask. Settled if
  // no return arrives within the network's return window.
  billpay_network({ payout, accountNumber }) {
    return {
      status: "sent", provider: "Mastercard RPPS", reference: `RPPS trace ${digits(15)}`,
      detail: `Bill payment for account ${mask(accountNumber)}`, autoConfirm: true,
    };
  },

  // Real: Stripe Issuing — create a single-use virtual card with a spending limit equal to the
  // payout, locked to the biller's merchant category. A staff member then pays on the biller's
  // official guest-pay page and records the confirmation number.
  virtual_card({ payout }) {
    return {
      status: "needs_agent", provider: "Stripe Issuing", reference: `ic_${rand(6).toLowerCase()}`,
      card: { last4: digits(4), expires: nextMonths(2), limitCents: payout.amountCents },
      detail: "Single-use card issued; pay on the biller's official guest-pay page",
    };
  },

  // Real: Lob — POST /v1/checks with the verified remit address, BillDrop's verified bank account,
  // the amount, and the member's account number on the memo line. Confirmed when the check clears.
  check({ payout, biller, accountNumber }) {
    if (!biller.remit) return { status: "failed", provider: "Lob", reference: "", detail: "No verified payment address for this biller" };
    const delivery = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    return {
      status: "sent", provider: "Lob", reference: `Check #${digits(6)}`,
      detail: `Mailed to ${biller.remit.name}, ${biller.remit.line1}, ${biller.remit.city}, ${biller.remit.state} ${biller.remit.zip} · memo: acct ${mask(accountNumber)} · expected ${delivery}`,
      autoConfirm: false, // confirmed when the check clears, by staff or the member
    };
  },
};

function nextMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
}

function dispatch(lane, ctx) {
  const adapter = adapters[lane];
  if (!adapter) return { status: "failed", provider: "", reference: "", detail: `No adapter for lane ${lane}` };
  return adapter(ctx);
}

// Provider-side confirmation (simulated): Method's balance update / no RPPS return.
function providerConfirmation(payout) {
  if (payout.provider === "Method") return "Lender reported the balance reduced by this payment";
  if (payout.provider === "Mastercard RPPS") return "Accepted by the biller through the bill-pay network (no return)";
  return "Confirmed by provider";
}

module.exports = { dispatch, providerConfirmation, mode: "simulated" };
