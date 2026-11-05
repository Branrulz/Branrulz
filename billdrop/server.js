// BillDrop — post your bills, let bored billionaires pay them off.
// Zero-dependency Node server: JSON API + static frontend + JSON-file storage.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 16 * 1024;

const CATEGORIES = ["medical", "rent", "student-loan", "credit-card", "utilities", "car", "other"];

// ---------- storage ----------

function seed() {
  const now = Date.now();
  const day = 86400000;
  const bill = (title, story, category, amountCents, biller, name, city, daysAgo, dueInDays) => ({
    id: crypto.randomUUID(),
    title, story, category, amountCents, biller, name, city,
    createdAt: new Date(now - daysAgo * day).toISOString(),
    dueDate: dueInDays == null ? null : new Date(now + dueInDays * day).toISOString().slice(0, 10),
    contributions: [],
  });
  const bills = [
    bill("ER visit after a bike crash", "Broke my wrist commuting to work. Insurance covered some, this is what's left.", "medical", 184250, "St. Mary's Hospital", "Dana", "Tulsa, OK", 3, 21),
    bill("Behind one month on rent", "Hours got cut at the warehouse. Back to full time next month but I'm short for November.", "rent", 95000, "Oakview Apartments", "Marcus", "Dayton, OH", 1, 6),
    bill("Last chunk of my student loan", "Been paying for 11 years. This is the final balance — would love to be done.", "student-loan", 412075, "Nelnet", "Priya", "Fresno, CA", 6, null),
    bill("Power bill before shutoff", "Got the disconnect notice. Two kids at home.", "utilities", 31244, "Duke Energy", "Keisha", "Greenville, SC", 0, 4),
    bill("Transmission died", "Need the car to get to my nursing shifts.", "car", 260000, "Mike's Auto Repair", "Tom", "Boise, ID", 2, 14),
  ];
  // Give one a head start so the feed shows progress.
  bills[3].contributions.push({ id: crypto.randomUUID(), patron: "Anonymous Yacht Owner", amountCents: 10000, message: "Keep the lights on.", createdAt: new Date(now - 3600000).toISOString() });
  return { bills };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const db = seed();
    save(db);
    return db;
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let db = load();

// ---------- helpers ----------

const paidCents = (b) => b.contributions.reduce((s, c) => s + c.amountCents, 0);

function publicBill(b) {
  const paid = paidCents(b);
  return { ...b, paidCents: paid, remainingCents: Math.max(0, b.amountCents - paid), paidOff: paid >= b.amountCents };
}

function str(v, field, { min = 0, max, required = true } = {}) {
  if (v == null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (required && s.length < min) throw new HttpError(400, `${field} is too short`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

// Accepts dollars as number or string ("12.34"), returns integer cents.
function cents(v, field, { min, max }) {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  const c = Math.round(n * 100);
  if (c < min) throw new HttpError(400, `${field} must be at least $${(min / 100).toFixed(2)}`);
  if (c > max) throw new HttpError(400, `${field} must be at most $${(max / 100).toLocaleString()}`);
  return c;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new HttpError(400, "Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ---------- API ----------

function listBills(url) {
  const category = url.searchParams.get("category");
  const status = url.searchParams.get("status") || "open"; // open | paid | all
  const sort = url.searchParams.get("sort") || "newest";   // newest | smallest | urgent | closest

  let bills = db.bills.map(publicBill);
  if (category && CATEGORIES.includes(category)) bills = bills.filter((b) => b.category === category);
  if (status === "open") bills = bills.filter((b) => !b.paidOff);
  if (status === "paid") bills = bills.filter((b) => b.paidOff);

  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    smallest: (a, b) => a.remainingCents - b.remainingCents,
    urgent: (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"),
    closest: (a, b) => b.paidCents / b.amountCents - a.paidCents / a.amountCents,
  };
  bills.sort(sorters[sort] || sorters.newest);
  return bills;
}

function stats() {
  const all = db.bills.map(publicBill);
  const patrons = new Map();
  for (const b of db.bills) {
    for (const c of b.contributions) {
      const key = c.patron || "Anonymous";
      patrons.set(key, (patrons.get(key) || 0) + c.amountCents);
    }
  }
  return {
    totalPaidCents: all.reduce((s, b) => s + b.paidCents, 0),
    billsPaidOff: all.filter((b) => b.paidOff).length,
    openBills: all.filter((b) => !b.paidOff).length,
    openNeedCents: all.filter((b) => !b.paidOff).reduce((s, b) => s + b.remainingCents, 0),
    leaderboard: [...patrons.entries()]
      .map(([patron, amountCents]) => ({ patron, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 10),
  };
}

function createBill(body) {
  const category = str(body.category, "Category", { max: 20 });
  if (!CATEGORIES.includes(category)) throw new HttpError(400, "Unknown category");
  let dueDate = null;
  if (body.dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) || Number.isNaN(Date.parse(body.dueDate))) {
      throw new HttpError(400, "Due date must be YYYY-MM-DD");
    }
    dueDate = body.dueDate;
  }
  const bill = {
    id: crypto.randomUUID(),
    title: str(body.title, "Title", { min: 4, max: 80 }),
    story: str(body.story, "Story", { min: 10, max: 1000 }),
    category,
    amountCents: cents(body.amount, "Amount", { min: 100, max: 100_000_000 }),
    biller: str(body.biller, "Who the bill is owed to", { min: 2, max: 80 }),
    name: str(body.name, "First name", { min: 1, max: 40 }),
    city: str(body.city, "City", { max: 60, required: false }),
    dueDate,
    createdAt: new Date().toISOString(),
    contributions: [],
  };
  db.bills.push(bill);
  save(db);
  return publicBill(bill);
}

function payBill(id, body) {
  const bill = db.bills.find((b) => b.id === id);
  if (!bill) throw new HttpError(404, "Bill not found");
  const remaining = bill.amountCents - paidCents(bill);
  if (remaining <= 0) throw new HttpError(409, "This bill is already paid off");

  // "payInFull" lets a patron cover whatever is left without doing math.
  const amountCents = body.payInFull
    ? remaining
    : cents(body.amount, "Amount", { min: 100, max: remaining });

  bill.contributions.push({
    id: crypto.randomUUID(),
    patron: str(body.patron, "Patron name", { max: 60, required: false }) || "Anonymous",
    amountCents,
    message: str(body.message, "Message", { max: 280, required: false }),
    createdAt: new Date().toISOString(),
  });
  save(db);
  return publicBill(bill);
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (req.method === "GET" && parts[1] === "categories" && parts.length === 2) return send(res, 200, CATEGORIES);
  if (req.method === "GET" && parts[1] === "stats" && parts.length === 2) return send(res, 200, stats());
  if (parts[1] === "bills") {
    if (parts.length === 2 && req.method === "GET") return send(res, 200, listBills(url));
    if (parts.length === 2 && req.method === "POST") return send(res, 201, createBill(await readJson(req)));
    if (parts.length === 3 && req.method === "GET") {
      const bill = db.bills.find((b) => b.id === parts[2]);
      if (!bill) throw new HttpError(404, "Bill not found");
      return send(res, 200, publicBill(bill));
    }
    if (parts.length === 4 && parts[3] === "pay" && req.method === "POST") {
      return send(res, 200, payBill(parts[2], await readJson(req)));
    }
  }
  throw new HttpError(404, "Not found");
}

// ---------- static files ----------

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(res, url) {
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": (MIME[path.extname(file)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else serveStatic(res, url);
  } catch (err) {
    if (err instanceof HttpError) send(res, err.status, { error: err.message });
    else { console.error(err); send(res, 500, { error: "Something went wrong" }); }
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`BillDrop running at http://localhost:${PORT}`));
}

module.exports = { server };
