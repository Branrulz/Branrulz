const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "billdrop-"));
const { server } = require("../server");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; r(); })));
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const req = async (p, body) => {
  const res = await fetch(base + p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return { status: res.status, data: await res.json() };
};

const newBill = { title: "Dentist bill", story: "Cracked a molar on a popcorn kernel.", category: "medical", amount: "250.50", biller: "Smile Dental", name: "Sam" };

test("seeds open bills", async () => {
  const { status, data } = await req("/bills");
  assert.equal(status, 200);
  assert.ok(data.length >= 5);
});

test("posts a bill and pays it off in two steps", async () => {
  const { status, data: bill } = await req("/bills", newBill);
  assert.equal(status, 201);
  assert.equal(bill.amountCents, 25050);

  const partial = await req(`/bills/${bill.id}/pay`, { amount: 50, patron: "Rich Person" });
  assert.equal(partial.data.remainingCents, 20050);
  assert.equal(partial.data.paidOff, false);

  const full = await req(`/bills/${bill.id}/pay`, { payInFull: true });
  assert.equal(full.data.paidOff, true);
  assert.equal(full.data.contributions[1].patron, "Anonymous");

  const again = await req(`/bills/${bill.id}/pay`, { payInFull: true });
  assert.equal(again.status, 409);

  const paid = await req("/bills?status=paid");
  assert.ok(paid.data.some((b) => b.id === bill.id));

  const stats = await req("/stats");
  assert.ok(stats.data.leaderboard.some((p) => p.patron === "Rich Person" && p.amountCents === 5000));
});

test("rejects overpaying and bad input", async () => {
  const { data: bill } = await req("/bills", newBill);
  assert.equal((await req(`/bills/${bill.id}/pay`, { amount: 9999 })).status, 400);
  assert.equal((await req("/bills", { ...newBill, amount: "abc" })).status, 400);
  assert.equal((await req("/bills", { ...newBill, category: "yacht" })).status, 400);
  assert.equal((await req("/bills", { ...newBill, title: "" })).status, 400);
  assert.equal((await req("/bills/nope/pay", { amount: 5 })).status, 404);
});
