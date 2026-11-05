// Biller directory + payment lanes.
//
// Members pick a biller from this directory instead of typing a name, so BillDrop always knows *how*
// to pay it and scammers can't invent a "biller" they control. Unlisted billers are allowed, but a
// reviewer must verify a payment address (or map them to a directory entry) before the bill goes live.
//
// In production this list would come from the payment networks themselves (Method's institution
// list, the Mastercard RPPS biller directory) plus BillDrop's own verified entries. The entries below
// are a small sample for the prototype. Check-lane addresses are for fictional local businesses only.

const LANES = {
  debt_api: {
    name: "Debt payment API",
    provider: "Method",
    how: "Paid electronically to the lender, and confirmed when the lender reports the new balance.",
  },
  billpay_network: {
    name: "Bill-pay network",
    provider: "Mastercard RPPS",
    how: "Paid electronically through the bill-pay network with your account number attached.",
  },
  virtual_card: {
    name: "Guest pay with a single-use card",
    provider: "Stripe Issuing",
    how: "Our team pays on the biller's official payment page with a single-use card and records the confirmation number.",
  },
  check: {
    name: "Mailed check",
    provider: "Lob",
    how: "A check is mailed to the biller's verified payment address with your account number on the memo line.",
  },
};

// account.pattern is checked against the account number with spaces and dashes removed.
const ACCT = {
  card: { pattern: "^\\d{15,16}$", hint: "15–16 digit card number" },
  loan: { pattern: "^[A-Za-z0-9]{6,20}$", hint: "6–20 letters or digits" },
  util10: { pattern: "^\\d{10}$", hint: "10 digits" },
  util12: { pattern: "^\\d{12}$", hint: "12 digits" },
  generic: { pattern: "^[A-Za-z0-9]{4,24}$", hint: "4–24 letters or digits" },
};

const BILLERS = [
  // Utilities, phone & internet: bill-pay network
  { id: "duke-energy", name: "Duke Energy", category: "utilities", lane: "billpay_network", account: ACCT.util12 },
  { id: "pge", name: "Pacific Gas and Electric (PG&E)", category: "utilities", lane: "billpay_network", account: ACCT.util10 },
  { id: "con-edison", name: "Con Edison", category: "utilities", lane: "billpay_network", account: ACCT.generic },
  { id: "georgia-power", name: "Georgia Power", category: "utilities", lane: "billpay_network", account: ACCT.util10 },
  { id: "xfinity", name: "Xfinity (Comcast)", category: "utilities", lane: "billpay_network", account: ACCT.generic },
  { id: "att", name: "AT&T", category: "utilities", lane: "billpay_network", account: ACCT.generic },
  { id: "verizon", name: "Verizon", category: "utilities", lane: "billpay_network", account: ACCT.generic },
  { id: "t-mobile", name: "T-Mobile", category: "utilities", lane: "billpay_network", account: ACCT.generic },

  // Credit cards: debt payment API
  { id: "chase-card", name: "Chase (credit card)", category: "credit-card", lane: "debt_api", account: ACCT.card },
  { id: "capital-one", name: "Capital One (credit card)", category: "credit-card", lane: "debt_api", account: ACCT.card },
  { id: "citi-card", name: "Citi (credit card)", category: "credit-card", lane: "debt_api", account: ACCT.card },
  { id: "discover-card", name: "Discover (credit card)", category: "credit-card", lane: "debt_api", account: ACCT.card },
  { id: "amex", name: "American Express", category: "credit-card", lane: "debt_api", account: ACCT.card },

  // Student & auto loans: debt payment API
  { id: "nelnet", name: "Nelnet", category: "student-loan", lane: "debt_api", account: ACCT.loan },
  { id: "mohela", name: "MOHELA", category: "student-loan", lane: "debt_api", account: ACCT.loan },
  { id: "aidvantage", name: "Aidvantage", category: "student-loan", lane: "debt_api", account: ACCT.loan },
  { id: "sallie-mae", name: "Sallie Mae", category: "student-loan", lane: "debt_api", account: ACCT.loan },
  { id: "ally-auto", name: "Ally Auto", category: "car", lane: "debt_api", account: ACCT.loan },
  { id: "toyota-financial", name: "Toyota Financial Services", category: "car", lane: "debt_api", account: ACCT.loan },

  // Medical: hospitals mostly take guest pay or the bill-pay network; small providers get checks
  { id: "st-marys", name: "St. Mary's Hospital", category: "medical", lane: "virtual_card", account: ACCT.generic },
  { id: "childrens-mercy", name: "Children's Mercy Hospital", category: "medical", lane: "billpay_network", account: ACCT.generic },
  { id: "labcorp", name: "Labcorp", category: "medical", lane: "virtual_card", account: ACCT.generic },
  { id: "quest", name: "Quest Diagnostics", category: "medical", lane: "virtual_card", account: ACCT.generic },
  { id: "metro-ambulance", name: "Metro Ambulance Services", category: "medical", lane: "check", account: ACCT.generic,
    remit: { name: "Metro Ambulance Services", line1: "PO Box 4410", city: "Denver", state: "CO", zip: "80201" } },

  // Rent: checks to verified property managers only
  { id: "oakview-apartments", name: "Oakview Apartments", category: "rent", lane: "check", account: ACCT.generic,
    remit: { name: "Oakview Apartments Leasing Office", line1: "1200 Oakview Dr", city: "Dayton", state: "OH", zip: "45402" } },

  // Other local businesses: checks
  { id: "mikes-auto", name: "Mike's Auto Repair", category: "car", lane: "check", account: ACCT.generic,
    remit: { name: "Mike's Auto Repair", line1: "88 Fairview Ave", city: "Boise", state: "ID", zip: "83702" } },
  { id: "greenlawn", name: "Greenlawn Funeral Home", category: "other", lane: "check", account: ACCT.generic,
    remit: { name: "Greenlawn Funeral Home", line1: "310 Magnolia St", city: "Mobile", state: "AL", zip: "36602" } },
];

const normalizeAccount = (s) => String(s || "").replace(/[\s-]/g, "");

function searchBillers(list, q, limit = 8) {
  const needle = String(q || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return list.slice(0, limit);
  const scored = [];
  for (const b of list) {
    const hay = b.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const i = hay.indexOf(needle);
    if (i >= 0) scored.push([i === 0 ? 0 : 1, b]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map(([, b]) => b);
}

// What the browser may see about a biller: never internal notes or who verified it.
const publicBiller = (b) => ({
  id: b.id, name: b.name, category: b.category, lane: b.lane, laneName: LANES[b.lane].name, how: LANES[b.lane].how,
  accountHint: b.account.hint, accountPattern: b.account.pattern,
});

module.exports = { LANES, BILLERS, ACCT, normalizeAccount, searchBillers, publicBiller };
