// Exercises the Stripe payment flow against a local stand-in for api.stripe.com.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// ---- fake Stripe ----
const intents = new Map();
const refunds = [];
const fakeStripe = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer sk_test_fake");
    const params = Object.fromEntries(new URLSearchParams(body));
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === "/v1/payment_intents") {
      const id = "pi_" + crypto.randomBytes(6).toString("hex");
      const pi = { id, object: "payment_intent", amount: Number(params.amount), currency: params.currency, status: "requires_payment_method", client_secret: id + "_secret_x", metadata: {} };
      intents.set(id, pi);
      return json(200, pi);
    }
    const m = req.url.match(/^\/v1\/payment_intents\/(pi_\w+)$/);
    if (req.method === "GET" && m) return intents.has(m[1]) ? json(200, intents.get(m[1])) : json(404, { error: { message: "no such" } });
    if (req.method === "POST" && req.url === "/v1/refunds") {
      refunds.push({ payment_intent: params.payment_intent, amount: Number(params.amount), key: req.headers["idempotency-key"] });
      return json(200, { id: "re_" + refunds.length, status: "succeeded" });
    }
    json(404, { error: { message: "unknown route" } });
  });
});
const succeed = (id) => { intents.get(id).status = "succeeded"; return intents.get(id); };

const WEBHOOK_SECRET = "whsec_test123";
let base, server, chargeFor;

before(async () => {
  await new Promise((r) => fakeStripe.listen(0, r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "billdrop-stripe-"));
  process.env.ADMIN_EMAILS = "admin@test.dev";
  process.env.AUTH_ATTEMPTS_PER_10_MIN = "1000";
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = `http://localhost:${fakeStripe.address().port}`;
  ({ server, chargeFor } = require("../server"));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/api`;
});
after(() => { server.close(); fakeStripe.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

function client() {
  let cookie = "";
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }), ...headers },
      body: typeof body === "string" ? body : body && JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
let n = 0;
async function signup(role, email) {
  const c = client();
  const r = await c("POST", "/auth/signup", { email: email || `${role}${++n}@test.dev`, password: "correct horse battery", role, displayName: "Pat " + n });
  assert.equal(r.status, 201);
  return c;
}
const openBill = async (c) => (await c("GET", "/bills?sort=smallest")).data[0];

test("config advertises Stripe test mode; the free /pay path is closed", async () => {
  const anon = client();
  const cfg = (await anon("GET", "/config")).data;
  assert.deepEqual(cfg.payments, { mode: "stripe", publishableKey: "pk_test_fake" });
  const patron = await signup("patron");
  const bill = await openBill(patron);
  assert.equal((await patron("POST", `/bills/${bill.id}/pay`, { amount: 5 })).status, 400);
});

test("payment intent → confirm records the gift once, with the patron covering card fees", async () => {
  const patron = await signup("patron");
  const bill = await openBill(patron);
  const { status, data: intent } = await patron("POST", `/bills/${bill.id}/payment-intent`, { amount: "50", message: "With compliments." });
  assert.equal(status, 200);
  assert.equal(intent.amountCents, 5000);
  assert.equal(intent.chargeCents, chargeFor(5000));
  assert.equal(intent.chargeCents, 5181); // (5000 + 30) / 0.971, rounded up
  assert.equal(intents.get(intent.paymentIntentId).amount, 5181);
  assert.ok(intent.clientSecret);

  assert.equal((await patron("POST", `/payments/${intent.paymentIntentId}/confirm`, {})).status, 409, "not paid yet");
  const other = await signup("patron");
  assert.equal((await other("POST", `/payments/${intent.paymentIntentId}/confirm`, {})).status, 404, "not yours");

  succeed(intent.paymentIntentId);
  const done = await patron("POST", `/payments/${intent.paymentIntentId}/confirm`, {});
  assert.equal(done.status, 200);
  assert.equal(done.data.receipt.amountCents, 5000);
  assert.equal(done.data.receipt.feeCents, 181);
  assert.equal(done.data.receipt.paidByCard, true);
  await patron("POST", `/payments/${intent.paymentIntentId}/confirm`, {});
  const giving = (await patron("GET", "/my/giving")).data;
  assert.equal(giving.length, 1, "confirming twice must not double-count");
});

test("two patrons race for the same bill: the loser is refunded in full", async () => {
  const a = await signup("patron");
  const b = await signup("patron");
  const bill = await openBill(a);
  const ia = (await a("POST", `/bills/${bill.id}/payment-intent`, { payInFull: true })).data;
  const ib = (await b("POST", `/bills/${bill.id}/payment-intent`, { payInFull: true })).data;
  succeed(ia.paymentIntentId); succeed(ib.paymentIntentId);
  const ra = await a("POST", `/payments/${ia.paymentIntentId}/confirm`, {});
  assert.equal(ra.data.bill.paidOff, true);
  const rb = await b("POST", `/payments/${ib.paymentIntentId}/confirm`, {});
  assert.equal(rb.data.refunded, true);
  assert.equal(rb.data.refundedCents, ib.chargeCents);
  assert.deepEqual(refunds.at(-1).payment_intent, ib.paymentIntentId);
  assert.equal(refunds.at(-1).amount, ib.chargeCents);
});

test("webhook: signature is enforced, and a succeeded event records the gift without the browser", async () => {
  const patron = await signup("patron");
  const bill = await openBill(patron);
  const intent = (await patron("POST", `/bills/${bill.id}/payment-intent`, { amount: "10" })).data;
  const event = JSON.stringify({ type: "payment_intent.succeeded", data: { object: succeed(intent.paymentIntentId) } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${event}`).digest("hex");

  const anon = client();
  assert.equal((await anon("POST", "/stripe/webhook", event, { "Stripe-Signature": `t=${t},v1=${"0".repeat(64)}` })).status, 400);
  assert.equal((await anon("POST", "/stripe/webhook", event, { "Stripe-Signature": `t=${t - 3600},v1=${sig}` })).status, 400, "stale timestamp");
  assert.equal((await anon("POST", "/stripe/webhook", event, { "Stripe-Signature": `t=${t},v1=${sig}` })).status, 200);
  assert.equal((await anon("POST", "/stripe/webhook", event, { "Stripe-Signature": `t=${t},v1=${sig}` })).status, 200, "retries are fine");

  const giving = (await patron("GET", "/my/giving")).data;
  assert.equal(giving.length, 1);
  assert.equal(giving[0].amountCents, 1000);
});

test("refunding a failed payout returns the full card charge through Stripe", async () => {
  const admin = await signup("patron", "admin@test.dev");
  const patron = await signup("patron");
  assert.equal((await patron("GET", "/admin/payouts")).status, 403);
  const bill = await openBill(patron);
  const intent = (await patron("POST", `/bills/${bill.id}/payment-intent`, { amount: "20" })).data;
  succeed(intent.paymentIntentId);
  const done = (await patron("POST", `/payments/${intent.paymentIntentId}/confirm`, {})).data;
  const payout = (await admin("GET", "/admin/payouts")).data.find((p) => p.contributionId === done.receipt.id);
  assert.equal(payout.status, "held", "7-day hold by default");
  assert.equal((await admin("POST", `/admin/payouts/${payout.id}/refund`, {})).status, 200);
  assert.equal(refunds.at(-1).payment_intent, intent.paymentIntentId);
  assert.equal(refunds.at(-1).amount, intent.chargeCents, "amount + fee back to the patron");
  assert.equal((await patron("GET", "/my/giving")).data.find((g) => g.id === done.receipt.id).refunded, true);
});

test("refuses to start with a live Stripe key", () => {
  assert.throws(() => execFileSync(process.execPath, ["-e", "require('./server')"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PUBLISHABLE_KEY: "pk_live_abc", ALLOW_LIVE_PAYMENTS: "" },
    stdio: "pipe",
  }), /live Stripe key/);
});
