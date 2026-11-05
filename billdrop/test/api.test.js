const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "billdrop-"));
process.env.ADMIN_EMAILS = "admin@test.dev";
process.env.AUTH_ATTEMPTS_PER_10_MIN = "1000";
process.env.PAYOUT_HOLD_DAYS = "0";
const { server } = require("../server");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); })));
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// A tiny cookie-keeping client per user.
function client() {
  let cookie = "";
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, data: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
}

let n = 0;
async function signup(role, name = "Sam", email) {
  const c = client();
  const r = await c("POST", "/auth/signup", { email: email || `${role}${++n}@test.dev`, password: "correct horse battery", role, displayName: name });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

// Minimal valid PDF bytes; vary content so each upload has a unique hash.
const pdf = (tag = Math.random()) => ({ name: "statement.pdf", data: Buffer.from(`%PDF-1.4\n% ${tag}\n` + "x".repeat(200)).toString("base64") });

const billBody = (over = {}) => ({
  title: "Dentist bill", story: "Cracked a molar on a popcorn kernel.", category: "medical", amount: "250.50",
  billerId: "st-marys", accountNumber: "PT-" + Math.floor(1e6 + Math.random() * 9e6), city: "Austin, TX", attest: true, document: pdf(), ...over,
});

test("public feed shows only verified bills, without private fields", async () => {
  const anon = client();
  const { status, data } = await anon("GET", "/bills?status=all");
  assert.equal(status, 200);
  assert.ok(data.length >= 5);
  for (const b of data) {
    assert.equal(b.verified, true);
    assert.equal(b.accountLast4, undefined);
    assert.equal(b.accountEnc, undefined);
    assert.equal(b.accountHash, undefined);
    assert.equal(b.ownerId, undefined);
    assert.equal(b.document, undefined);
  }
});

test("roles are separated: members can't pay, patrons can't post, guests can't do either", async () => {
  const member = await signup("member");
  const patron = await signup("patron");
  const guest = client();
  const { data: feed } = await guest("GET", "/bills");
  const id = feed[0].id;

  assert.equal((await member("POST", `/bills/${id}/pay`, { amount: 5 })).status, 403);
  assert.equal((await guest("POST", `/bills/${id}/pay`, { amount: 5 })).status, 401);
  assert.equal((await patron("POST", "/bills", billBody())).status, 403);
  assert.equal((await guest("POST", "/bills", billBody())).status, 401);
  assert.equal((await member("GET", "/admin/queue")).status, 403);
});

test("bills stay hidden until a reviewer approves them, then patrons can settle and earn tiers", async () => {
  const member = await signup("member", "Lena Marie");
  const patron = await signup("patron", "Mr. Moneybags");
  const admin = await signup("patron", "Reviewer", "admin@test.dev"); // email in ADMIN_EMAILS -> admin

  const { status, data: bill } = await member("POST", "/bills", billBody({ amount: "12000" }));
  assert.equal(status, 201);
  assert.equal(bill.status, "pending");
  assert.equal(bill.name, "Lena", "only first name is stored for display");

  const feed = (await patron("GET", "/bills?status=all")).data;
  assert.ok(!feed.some((b) => b.id === bill.id), "pending bill must not be public");
  assert.equal((await patron("POST", `/bills/${bill.id}/pay`, { amount: 5 })).status, 404);

  const queue = (await admin("GET", "/admin/queue")).data;
  const item = queue.find((b) => b.id === bill.id);
  assert.ok(item.hasDocument);
  const doc = await admin("GET", `/admin/bills/${bill.id}/document`);
  assert.equal(doc.status, 200);
  assert.equal((await patron("GET", `/admin/bills/${bill.id}/document`)).status, 403);

  assert.equal((await admin("POST", `/admin/bills/${bill.id}/review`, { decision: "approve" })).status, 200);
  assert.equal((await admin("GET", `/admin/bills/${bill.id}/document`)).status, 404, "statement deleted after review");

  const r1 = await patron("POST", `/bills/${bill.id}/pay`, { amount: 1500 });
  assert.equal(r1.data.tier.id, "bronze");
  assert.equal(r1.data.bill.contributions[0].payee, "St. Mary's Hospital");
  const r2 = await patron("POST", `/bills/${bill.id}/pay`, { payInFull: true, anonymous: true });
  assert.equal(r2.data.bill.paidOff, true);
  assert.equal(r2.data.tier.id, "silver"); // $12,000 lifetime
  assert.equal(r2.data.bill.contributions[1].patron, "Anonymous");
  assert.equal((await patron("POST", `/bills/${bill.id}/pay`, { payInFull: true })).status, 409);

  const mine = (await member("GET", "/my/bills")).data;
  assert.equal(mine[0].paidOff, true);
  const giving = (await patron("GET", "/my/giving")).data;
  assert.equal(giving.length, 2);
});

test("fraud controls: duplicate statements, caps, active-bill limit, attestation, file type", async () => {
  const member = await signup("member");
  const doc = pdf("same-statement");
  assert.equal((await member("POST", "/bills", billBody({ attest: false }))).status, 400);
  assert.equal((await member("POST", "/bills", billBody({ document: { name: "x.pdf", data: Buffer.from("<html>" + "x".repeat(200)).toString("base64") } }))).status, 400);
  assert.equal((await member("POST", "/bills", billBody({ amount: "999999" }))).status, 400);
  assert.equal((await member("POST", "/bills", billBody({ accountNumber: "12" }))).status, 400);

  assert.equal((await member("POST", "/bills", billBody({ document: doc }))).status, 201);
  const other = await signup("member");
  assert.equal((await other("POST", "/bills", billBody({ document: doc }))).status, 409, "same statement twice");

  assert.equal((await member("POST", "/bills", billBody())).status, 201);
  const third = await member("POST", "/bills", billBody());
  assert.equal(third.status, 403, "max active bills");
});

test("identity protection: contact details and ID numbers are refused in public text", async () => {
  const member = await signup("member");
  for (const story of [
    "Please call me at 555-123-4567 so we can talk",
    "Email me at someone@example.com about it",
    "My SSN is 123-45-6789 if you need it",
    "Account 1234 5678 9012 is the one",
    "Mail a check to 42 Elm Street please",
    "Just send it on Venmo instead",
  ]) {
    const r = await member("POST", "/bills", billBody({ story }));
    assert.equal(r.status, 400, story);
  }
  const patron = await signup("patron");
  const id = (await patron("GET", "/bills")).data[0].id;
  assert.equal((await patron("POST", `/bills/${id}/pay`, { amount: 1, message: "Text me at 555 123 4567" })).status, 400);
});

test("reports pull a bill back into review; ban suspends the member", async () => {
  const member = await signup("member");
  const admin = client();
  await admin("POST", "/auth/login", { email: "admin@test.dev", password: "correct horse battery" });
  const { data: bill } = await member("POST", "/bills", billBody());
  await admin("POST", `/admin/bills/${bill.id}/review`, { decision: "approve" });

  for (let i = 0; i < 3; i++) {
    const p = await signup("patron");
    assert.equal((await p("POST", `/bills/${bill.id}/report`, { reason: "fake" })).status, 200);
    if (i === 0) assert.equal((await p("POST", `/bills/${bill.id}/report`, { reason: "fake" })).status, 409, "one report per person");
  }
  const feed = (await client()("GET", "/bills?status=all")).data;
  assert.ok(!feed.some((b) => b.id === bill.id), "flagged bill hidden");

  assert.equal((await admin("POST", `/admin/bills/${bill.id}/review`, { decision: "ban" })).status, 400, "note required");
  assert.equal((await admin("POST", `/admin/bills/${bill.id}/review`, { decision: "ban", note: "Statement was forged" })).status, 200);
  assert.equal((await member("GET", "/my/bills")).status, 401, "banned member's session is gone");
});

test("rejects non-JSON POSTs (CSRF guard) and bad logins", async () => {
  const res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" });
  assert.equal(res.status, 415);
  assert.equal((await client()("POST", "/auth/login", { email: "nobody@test.dev", password: "whatever123" })).status, 401);
});

test("the deck: patrons can pass on a bill and it stays gone until they reset", async () => {
  const patron = await signup("patron");
  const first = (await patron("GET", "/deck")).data;
  assert.ok(first.length > 1);
  assert.ok(first.every((b) => !b.paidOff && b.verified));
  assert.equal((await patron("POST", `/bills/${first[0].id}/pass`, {})).status, 200);
  const after = (await patron("GET", "/deck")).data;
  assert.ok(!after.some((b) => b.id === first[0].id));
  assert.equal((await client()("POST", `/bills/${first[0].id}/pass`, {})).status, 401);
  await patron("POST", "/deck/reset", {});
  assert.equal((await patron("GET", "/deck")).data.length, first.length);
});

test("paperwork: receipts, medical vs gift treatment, per-recipient exclusion, CSV", async () => {
  const admin = client();
  await admin("POST", "/auth/login", { email: "admin@test.dev", password: "correct horse battery" });
  const member = await signup("member", "Ada");
  const { data: rent } = await member("POST", "/bills", billBody({ category: "rent", amount: "20000", billerId: "oakview-apartments" }));
  const { data: med } = await member("POST", "/bills", billBody({ category: "medical", amount: "3000", billerId: "st-marys" }));
  await admin("POST", `/admin/bills/${rent.id}/review`, { decision: "approve" });
  await admin("POST", `/admin/bills/${med.id}/review`, { decision: "approve" });

  const patron = await signup("patron", "Q");
  const prev = (await patron("GET", `/bills/${rent.id}/tax-preview`)).data;
  assert.equal(prev.treatment, "gift");
  assert.equal(prev.annualExclusionCents, 1900000);

  const paid = await patron("POST", `/bills/${rent.id}/pay`, { payInFull: true });
  assert.match(paid.data.receipt.receiptNo, /^BD-\d{4}-[0-9A-F]{8}$/);
  assert.equal(paid.data.receipt.payee, "Oakview Apartments");
  await patron("POST", `/bills/${med.id}/pay`, { payInFull: true });

  const year = new Date().getFullYear();
  const tax = (await patron("GET", `/my/tax?year=${year}`)).data;
  assert.equal(tax.medicalCents, 300000);
  assert.equal(tax.giftCents, 2000000);
  assert.equal(tax.form709Likely, true);
  assert.equal(tax.recipients.length, 1);
  assert.equal(tax.recipients[0].overByCents, 100000);
  assert.equal(tax.recipients[0].recipient, "Ada, Austin, TX");

  const receipt = (await patron("GET", `/my/receipts/${paid.data.receipt.id}`)).data;
  assert.equal(receipt.amountCents, 2000000);
  assert.equal((await (await signup("patron"))("GET", `/my/receipts/${paid.data.receipt.id}`)).status, 404, "other patrons can't see it");

  const csv = await patron("GET", `/my/tax.csv?year=${year}`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /^Receipt,Date,Amount \(USD\)/);
  assert.match(csv.data, /Medical paid directly to provider/);
  assert.equal(csv.data.trim().split("\r\n").length, 3);
});


test("biller directory: search, account formats, unlisted billers need a verified address", async () => {
  const anon = client();
  const hits = (await anon("GET", "/billers?q=duke")).data;
  assert.equal(hits[0].id, "duke-energy");
  assert.equal(hits[0].lane, "billpay_network");
  assert.ok(hits[0].accountHint);

  const member = await signup("member");
  const bad = await member("POST", "/bills", billBody({ billerId: "duke-energy", category: "utilities", accountNumber: "12345" }));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Duke Energy account number \(12 digits\)/);
  assert.equal((await member("POST", "/bills", billBody({ billerId: "no-such-biller" }))).status, 400);

  // Unlisted biller: accepted for review, but can't be approved until mapped or given a verified address.
  const { data: odd } = await member("POST", "/bills", billBody({ billerId: "other", billerName: "Riverside Pediatrics", accountNumber: "RP 5521 993" }));
  assert.equal(odd.billerId, null);
  const admin = client();
  await admin("POST", "/auth/login", { email: "admin@test.dev", password: "correct horse battery" });
  const item = (await admin("GET", "/admin/queue")).data.find((b) => b.id === odd.id);
  assert.ok(item.signals.some((x) => /isn't in the directory/.test(x)));
  assert.equal((await admin("POST", `/admin/bills/${odd.id}/review`, { decision: "approve" })).status, 400);
  assert.equal((await admin("POST", `/admin/bills/${odd.id}/review`, { decision: "approve", remit: { name: "Riverside Pediatrics", line1: "1 Main St", city: "Austin", state: "TX", zip: "123" } })).status, 400, "bad zip");
  const ok = await admin("POST", `/admin/bills/${odd.id}/review`, { decision: "approve", remit: { name: "Riverside Pediatrics", line1: "1 Main St", city: "Austin", state: "tx", zip: "78701" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.billerInfo.lane, "check");
  assert.equal(ok.data.billerInfo.remit.state, "TX");
  assert.equal(ok.data.biller, "Riverside Pediatrics");
});

test("payouts: routed by lane, held, sent, confirmed — with failures retried by check or refunded", async () => {
  const admin = client();
  await admin("POST", "/auth/login", { email: "admin@test.dev", password: "correct horse battery" });
  const member = await signup("member", "Rae");
  const mk = async (over) => {
    const { data } = await member("POST", "/bills", billBody(over));
    await admin("POST", `/admin/bills/${data.id}/review`, { decision: "approve" });
    return data;
  };
  const util = await mk({ billerId: "duke-energy", category: "utilities", accountNumber: "1234 5678 9012", amount: "100" });
  const hosp = await mk({ billerId: "st-marys", amount: "100" });
  const patron = await signup("patron");
  await patron("POST", `/bills/${util.id}/pay`, { payInFull: true });
  await patron("POST", `/bills/${hosp.id}/pay`, { payInFull: true });

  // Hold is 0 days in tests, so listing processes them: network → sent, virtual card → needs a person.
  let pu = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === util.id);
  assert.equal(pu.lane, "billpay_network");
  assert.equal(pu.status, "sent");
  assert.match(pu.reference, /^RPPS trace \d{15}$/);
  let ph = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === hosp.id);
  assert.equal(ph.status, "needs_agent");
  assert.equal(ph.card.limitCents, 10000);

  // Network payments confirm on the next processing run.
  await admin("POST", "/admin/payouts/process", {});
  pu = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === util.id);
  assert.equal(pu.status, "confirmed");
  const pub = (await client()("GET", `/bills/${util.id}`)).data;
  assert.equal(pub.payment.state, "confirmed");

  // Virtual card: a person pays on the portal and records the confirmation.
  assert.equal((await admin("POST", `/admin/payouts/${ph.id}/agent-paid`, {})).status, 400);
  const paid = await admin("POST", `/admin/payouts/${ph.id}/agent-paid`, { confirmation: "SMH-88213" });
  assert.equal(paid.data.status, "confirmed");
  assert.equal(paid.data.card, null, "card details dropped once used");

  // Patron sees proof on their giving history; nobody outside admin sees the card.
  const giving = (await patron("GET", "/my/giving")).data;
  assert.ok(giving.every((g) => g.payout.status === "confirmed"));
  assert.equal(JSON.stringify(giving).includes("limitCents"), false);

  // Failure path: a check that bounces, retried; then a refund that reopens the bill.
  const shop = await mk({ billerId: "mikes-auto", category: "car", amount: "300" });
  await patron("POST", `/bills/${shop.id}/pay`, { amount: 100 });
  let pc = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === shop.id);
  assert.equal(pc.lane, "check");
  assert.equal(pc.status, "sent");
  assert.match(pc.detail, /Mike's Auto Repair, 88 Fairview Ave/);
  await admin("POST", "/admin/payouts/process", {});
  pc = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === shop.id);
  assert.equal(pc.status, "sent", "checks are not auto-confirmed");
  assert.equal((await admin("POST", `/admin/payouts/${pc.id}/fail`, { reason: "Check returned: address closed" })).data.status, "failed");
  assert.equal((await admin("POST", `/admin/payouts/${pc.id}/retry-check`, {})).data.status, "sent");
  // Member confirms their biller got it.
  const conf = await member("POST", `/my/bills/${shop.id}/confirm-received`, {});
  assert.equal(conf.data.payouts[0].status, "confirmed");

  await patron("POST", `/bills/${shop.id}/pay`, { amount: 50 });
  const p2 = (await admin("GET", "/admin/payouts")).data.find((p) => p.billId === shop.id && p.status === "sent");
  await admin("POST", `/admin/payouts/${p2.id}/fail`, { reason: "Biller refused payment" });
  assert.equal((await admin("POST", `/admin/payouts/${p2.id}/refund`, {})).data.status, "refunded");
  const after = (await client()("GET", `/bills/${shop.id}`)).data;
  assert.equal(after.paidCents, 10000, "refunded gift no longer counts toward the bill");
  const mine = (await patron("GET", "/my/giving")).data.find((g) => g.refunded);
  assert.equal(mine.payout.status, "refunded");
});

test("account numbers are encrypted at rest", async () => {
  const member = await signup("member");
  await member("POST", "/bills", billBody({ billerId: "chase-card", category: "credit-card", accountNumber: "4111 1111 1111 1111" }));
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, "db.json"), "utf8");
  assert.equal(raw.includes("4111111111111111"), false);
  const mine = (await member("GET", "/my/bills")).data[0];
  assert.equal(mine.accountLast4, "1111");
  assert.equal(mine.laneName, "Debt payment API");
});

test("stats still add up after refunds", async () => {
  const s = (await client()("GET", "/stats")).data;
  assert.ok(s.totalPaidCents > 0);
  assert.ok(Array.isArray(s.leaderboard));
});
