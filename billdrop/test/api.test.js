const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "billdrop-"));
process.env.ADMIN_EMAILS = "admin@test.dev";
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
  biller: "Smile Dental", accountLast4: "4821", city: "Austin, TX", attest: true, document: pdf(), ...over,
});

test("public feed shows only verified bills, without private fields", async () => {
  const anon = client();
  const { status, data } = await anon("GET", "/bills?status=all");
  assert.equal(status, 200);
  assert.ok(data.length >= 5);
  for (const b of data) {
    assert.equal(b.verified, true);
    assert.equal(b.accountLast4, undefined);
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

  const { status, data: bill } = await member("POST", "/bills", billBody({ amount: "1200" }));
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

  const r1 = await patron("POST", `/bills/${bill.id}/pay`, { amount: 150 });
  assert.equal(r1.data.tier.id, "bronze");
  assert.equal(r1.data.bill.contributions[0].payee, "Smile Dental");
  const r2 = await patron("POST", `/bills/${bill.id}/pay`, { payInFull: true, anonymous: true });
  assert.equal(r2.data.bill.paidOff, true);
  assert.equal(r2.data.tier.id, "silver");
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
  assert.equal((await member("POST", "/bills", billBody({ accountLast4: "12" }))).status, 400);

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
