// BillDrop — a private ledger of real bills, settled by patrons.
// Zero-dependency Node server: JSON API + static frontend + JSON-file storage.
//
// Roles
//   member  — has bills that need settling; can submit bills, can't pay.
//   patron  — settles bills; earns tiers (Bronze → Black Card); can't submit.
//   admin   — reviews submitted bills before they go live. Granted to emails in ADMIN_EMAILS.
//
// Trust & safety rules enforced here are documented in TRUST.md.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const AUTH_ATTEMPTS = Number(process.env.AUTH_ATTEMPTS_PER_10_MIN) || 20; // sign-ups + logins per IP

const MAX_BODY = 16 * 1024;
const MAX_UPLOAD_BODY = 6 * 1024 * 1024; // base64 of a 4 MB file fits under this
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const SESSION_DAYS = 30;

// Policy knobs (see TRUST.md)
const POLICY = {
  maxBillCents: 25_000_00,     // a single bill can't exceed $25,000
  maxActiveBills: 2,           // bills under review or still open, per member
  maxRejections: 3,            // members with this many rejections can't submit more
  reportsToFlag: 3,            // distinct reports that pull a live bill back into review
};

const CATEGORIES = ["medical", "rent", "student-loan", "credit-card", "utilities", "car", "other"];

const TIERS = [
  { id: "patron", name: "Patron", minCents: 0 },
  { id: "bronze", name: "Bronze", minCents: 1_000_00 },
  { id: "silver", name: "Silver", minCents: 10_000_00 },
  { id: "gold", name: "Gold", minCents: 50_000_00 },
  { id: "platinum", name: "Platinum", minCents: 250_000_00 },
  { id: "black", name: "Black Card", minCents: 1_000_000_00 },
];

// Gift-tax figures used on patron paperwork. Not tax advice; update each year from the IRS.
// Annual exclusion per recipient (IRC §2503(b)). Medical bills paid straight to the provider fall
// under the separate, unlimited §2503(e) exclusion.
const ANNUAL_EXCLUSION_CENTS = { 2025: 19_000_00, 2026: 19_000_00 };
const exclusionFor = (year) => ANNUAL_EXCLUSION_CENTS[year] ??
  ANNUAL_EXCLUSION_CENTS[Math.max(...Object.keys(ANNUAL_EXCLUSION_CENTS).map(Number))];

// ---------- errors & small utils ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const uuid = () => crypto.randomUUID();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function str(v, field, { min = 0, max, required = true } = {}) {
  if (v == null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (required && s.length < Math.max(1, min)) throw new HttpError(400, `${field} is too short`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

// Accepts dollars as number or string ("12.34"), returns integer cents.
function cents(v, field, { min, max }) {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  const c = Math.round(n * 100);
  if (c < min) throw new HttpError(400, `${field} must be at least $${(min / 100).toFixed(2)}`);
  if (c > max) throw new HttpError(400, `${field} must be at most $${(max / 100).toLocaleString("en-US")}`);
  return c;
}

// ---------- identity protection ----------
// Public text (bill titles, stories, patron messages) must not carry anything that lets a stranger
// contact a member or impersonate them. See TRUST.md, "Protecting members' identities".
const PII_PATTERNS = [
  [/[^\s@]+@[^\s@]+\.[a-z]{2,}/i, "an email address"],
  [/(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|me|co|ly|app|link)\b/i, "a link"],
  [/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, "a phone number"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "a Social Security number"],
  [/(?:\d[\s-]?){9,}/, "an account or ID number"],
  [/\b\d+\s+(?:[a-z]+\s){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|apt|unit)\b/i, "a street address"],
  [/\b(venmo|cash\s?app|zelle|paypal|telegram|whatsapp|snapchat|instagram|dm me|text me|call me)\b/i, "contact or payment details"],
];

function assertNoPII(text, field) {
  for (const [re, what] of PII_PATTERNS) {
    if (re.test(text)) {
      throw new HttpError(400, `${field} looks like it contains ${what}. For everyone's safety, keep personal and contact details off BillDrop.`);
    }
  }
  return text;
}

// ---------- passwords & sessions ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  return `bd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${COOKIE_SECURE ? "; Secure" : ""}`;
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[sha256(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 86400000 };
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
}

function currentUser(req) {
  const token = parseCookies(req).bd_session;
  if (!token) return null;
  const s = db.sessions[sha256(token)];
  if (!s || s.expires < Date.now()) return null;
  const user = db.users.find((u) => u.id === s.userId);
  return user && !user.banned ? user : null;
}

function requireUser(req, ...roles) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Please sign in first");
  if (roles.length && !roles.includes(user.role)) {
    const need = { member: "members", patron: "patrons", admin: "reviewers" };
    throw new HttpError(403, `Only ${roles.map((r) => need[r]).join(" or ")} can do that`);
  }
  return user;
}

// ---------- rate limiting (in-memory, per key) ----------

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new HttpError(429, "Too many attempts. Please wait a few minutes.");
  recent.push(now);
  hits.set(key, recent);
}

// ---------- storage ----------

function seed() {
  const now = Date.now();
  const day = 86400000;
  const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  const lockedPassword = () => hashPassword(crypto.randomBytes(24).toString("hex")); // seed users can't log in

  const user = (displayName, role, email) => ({
    id: uuid(), email, passwordHash: lockedPassword(), role, displayName, createdAt: iso(60), banned: false,
  });
  const members = ["Dana", "Marcus", "Priya", "Keisha", "Tom", "Alma", "Jordan", "Ruth"].map((n) =>
    user(n, "member", `${n.toLowerCase()}@seed.billdrop.invalid`));
  const duke = user("The Duke of Somewhere", "patron", "duke@seed.billdrop.invalid");
  const margaux = user("Margaux V.", "patron", "margaux@seed.billdrop.invalid");
  const yacht = user("Anonymous Yacht Owner", "patron", "yacht@seed.billdrop.invalid");

  const bill = (owner, title, story, category, amountCents, biller, city, daysAgo, dueInDays) => ({
    id: uuid(), ownerId: owner.id, title, story, category, amountCents, biller, name: owner.displayName, city,
    accountLast4: String(1000 + Math.floor(Math.random() * 9000)),
    document: null, status: "verified", reviewNote: "", reports: [],
    createdAt: iso(daysAgo), verifiedAt: iso(daysAgo),
    dueDate: dueInDays == null ? null : new Date(now + dueInDays * day).toISOString().slice(0, 10),
    contributions: [],
  });
  const give = (b, patron, amountCents, message, daysAgo) => b.contributions.push({
    id: uuid(), patronId: patron.id, patronName: patron.displayName, anonymous: false,
    amountCents, message, payee: b.biller, createdAt: iso(daysAgo),
  });

  const [dana, marcus, priya, keisha, tom, alma, jordan, ruth] = members;
  const bills = [
    bill(dana, "ER visit after a bike crash", "Broke my wrist commuting to work. Insurance covered some, this is what's left.", "medical", 184250, "St. Mary's Hospital", "Tulsa, OK", 3, 21),
    bill(marcus, "Behind one month on rent", "Hours got cut at the warehouse. Back to full time next month but I'm short for November.", "rent", 95000, "Oakview Apartments", "Dayton, OH", 1, 6),
    bill(priya, "Last chunk of my student loan", "Been paying for 11 years. This is the final balance — would love to be done.", "student-loan", 412075, "Nelnet", "Fresno, CA", 6, null),
    bill(keisha, "Power bill before shutoff", "Got the disconnect notice. Two kids at home.", "utilities", 31244, "Duke Energy", "Greenville, SC", 0, 4),
    bill(tom, "Transmission died", "Need the car to get to my nursing shifts.", "car", 260000, "Mike's Auto Repair", "Boise, ID", 2, 14),
    // Settled history, so the Circle and tiers have something to show.
    bill(alma, "NICU stay for our twins", "Born at 31 weeks. They're home and healthy now; the bill followed us.", "medical", 2480000, "Children's Mercy Hospital", "Kansas City, MO", 40, null),
    bill(jordan, "My mother's funeral", "She deserved a proper goodbye. I put the balance on a payment plan.", "other", 940000, "Greenlawn Funeral Home", "Mobile, AL", 30, null),
    bill(ruth, "Student loan, final balance", "Nineteen years of payments. Teacher salary.", "student-loan", 1850000, "MOHELA", "Burlington, VT", 25, null),
  ];
  give(bills[3], yacht, 10000, "Keep the lights on.", 0.05);
  give(bills[5], duke, 2480000, "Welcome to the world, little ones.", 38);
  give(bills[6], duke, 940000, "With deepest sympathy.", 28);
  give(bills[7], margaux, 1850000, "Class dismissed.", 22);

  return { users: [...members, duke, margaux, yacht], sessions: {}, bills };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (Array.isArray(data.users)) return data;
    // Pre-accounts prototype data: start fresh.
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const fresh = seed();
  save(fresh);
  return fresh;
}

function save(data = db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let db = load();

// ---------- derived data ----------

const paidCents = (b) => b.contributions.reduce((s, c) => s + c.amountCents, 0);
const isPaidOff = (b) => paidCents(b) >= b.amountCents;

function givenBy(userId) {
  let total = 0;
  for (const b of db.bills) for (const c of b.contributions) if (c.patronId === userId) total += c.amountCents;
  return total;
}

function tierFor(totalCents) {
  let i = 0;
  while (i + 1 < TIERS.length && totalCents >= TIERS[i + 1].minCents) i++;
  const next = TIERS[i + 1] || null;
  return { ...TIERS[i], next: next && { id: next.id, name: next.name, minCents: next.minCents, toGoCents: next.minCents - totalCents } };
}

function contributionView(c) {
  const patron = c.anonymous ? null : db.users.find((u) => u.id === c.patronId);
  return {
    id: c.id,
    patron: c.anonymous ? "Anonymous" : c.patronName,
    tier: patron ? tierFor(givenBy(patron.id)).id : null,
    amountCents: c.amountCents, message: c.message, payee: c.payee, createdAt: c.createdAt,
  };
}

// What anyone can see about a live bill. No account numbers, documents, owner ids or reports.
function publicBill(b) {
  const paid = paidCents(b);
  return {
    id: b.id, title: b.title, story: b.story, category: b.category, biller: b.biller,
    name: b.name, city: b.city, dueDate: b.dueDate, createdAt: b.createdAt,
    verified: b.status === "verified",
    amountCents: b.amountCents, paidCents: paid,
    remainingCents: Math.max(0, b.amountCents - paid), paidOff: paid >= b.amountCents,
    contributions: b.contributions.map(contributionView),
  };
}

// What the member who posted it can see.
function ownerBill(b) {
  return { ...publicBill(b), status: b.status, reviewNote: b.reviewNote, accountLast4: b.accountLast4 };
}

// What a reviewer sees, including fraud signals.
function adminBill(b) {
  const owner = db.users.find((u) => u.id === b.ownerId);
  const sameAccount = db.bills.filter((o) => o.id !== b.id && o.ownerId !== b.ownerId &&
    normalize(o.biller) === normalize(b.biller) && o.accountLast4 === b.accountLast4);
  const ownerHistory = db.bills.filter((o) => o.ownerId === b.ownerId && o.id !== b.id);
  return {
    ...ownerBill(b),
    hasDocument: Boolean(b.document?.file),
    documentName: b.document?.name || null,
    reports: b.reports.map((r) => ({ reason: r.reason, details: r.details, createdAt: r.createdAt })),
    owner: owner && {
      displayName: owner.displayName, email: owner.email, createdAt: owner.createdAt,
      otherBills: ownerHistory.length,
      rejectedBills: ownerHistory.filter((o) => o.status === "rejected").length,
    },
    signals: [
      ...sameAccount.map((o) => `Same biller and account (…${b.accountLast4}) as another member's bill: “${o.title}” (${o.status})`),
      ...(owner && Date.now() - Date.parse(owner.createdAt) < 86400000 ? ["Account is less than a day old"] : []),
      ...(b.amountCents >= 10_000_00 ? ["Large amount — confirm with the biller directly"] : []),
      ...(!b.document?.file ? ["No statement on file"] : []),
    ],
  };
}

function meView(user) {
  const base = { id: user.id, email: user.email, displayName: user.displayName, role: user.role, createdAt: user.createdAt };
  if (user.role === "patron") {
    const total = givenBy(user.id);
    return { ...base, givenCents: total, tier: tierFor(total) };
  }
  if (user.role === "member") {
    const mine = db.bills.filter((b) => b.ownerId === user.id);
    const active = mine.filter((b) => b.status === "pending" || b.status === "flagged" || (b.status === "verified" && !isPaidOff(b))).length;
    const rejected = mine.filter((b) => b.status === "rejected").length;
    let canSubmit = true, cantSubmitReason = "";
    if (rejected >= POLICY.maxRejections) { canSubmit = false; cantSubmitReason = "Your account can't submit new bills after repeated rejections. Contact support."; }
    else if (active >= POLICY.maxActiveBills) { canSubmit = false; cantSubmitReason = `You can have up to ${POLICY.maxActiveBills} bills open at a time.`; }
    return { ...base, canSubmit, cantSubmitReason };
  }
  return base;
}

// ---------- HTTP helpers ----------

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = MAX_BODY) {
  // Requiring a JSON content type means a plain cross-site <form> can't hit the API (CSRF guard,
  // alongside SameSite=Lax cookies).
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
    return Promise.reject(new HttpError(415, "Expected application/json"));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new HttpError(400, "Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || "unknown";

// ---------- documents ----------

const DOC_TYPES = [
  { mime: "application/pdf", ext: ".pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: "image/png", ext: ".png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: ".jpg", magic: [0xff, 0xd8, 0xff] },
];

function parseDocument(doc) {
  if (!doc || typeof doc !== "object" || typeof doc.data !== "string") {
    throw new HttpError(400, "Please attach a statement or invoice for this bill");
  }
  const buf = Buffer.from(doc.data, "base64");
  if (buf.length < 100) throw new HttpError(400, "That file looks empty");
  if (buf.length > MAX_DOC_BYTES) throw new HttpError(400, "Statement must be 4 MB or smaller");
  const type = DOC_TYPES.find((t) => t.magic.every((byte, i) => buf[i] === byte)); // check real bytes, not the filename
  if (!type) throw new HttpError(400, "Statement must be a PDF, PNG or JPG");
  const hash = sha256(buf);
  if (db.bills.some((b) => b.document?.hash === hash)) {
    throw new HttpError(409, "This exact statement has already been submitted");
  }
  const name = str(doc.name, "File name", { max: 120, required: false }).replace(/[^\w.\- ]/g, "_") || "statement" + type.ext;
  return { buf, meta: { hash, mime: type.mime, file: hash + type.ext, name, bytes: buf.length } };
}

// ---------- API: auth ----------

async function signup(req, res) {
  rateLimit("auth:" + clientIp(req), AUTH_ATTEMPTS, 10 * 60000);
  const body = await readJson(req);
  const email = str(body.email, "Email", { max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Please enter a valid email");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 10) throw new HttpError(400, "Password must be at least 10 characters");
  if (password.length > 200) throw new HttpError(400, "Password is too long");
  let role = body.role;
  if (role !== "member" && role !== "patron") throw new HttpError(400, "Choose whether you're submitting bills or settling them");
  if (ADMIN_EMAILS.includes(email)) role = "admin";
  if (db.users.some((u) => u.email === email)) throw new HttpError(409, "An account with that email already exists");

  const user = {
    id: uuid(), email, passwordHash: hashPassword(password), role,
    displayName: assertNoPII(str(body.displayName, "Name", { min: 1, max: role === "member" ? 40 : 60 }), "Name"),
    createdAt: new Date().toISOString(), banned: false,
  };
  db.users.push(user);
  startSession(res, user);
  save();
  send(res, 201, meView(user));
}

async function login(req, res) {
  rateLimit("auth:" + clientIp(req), AUTH_ATTEMPTS, 10 * 60000);
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const user = db.users.find((u) => u.email === email);
  if (!user || !checkPassword(String(body.password || ""), user.passwordHash)) {
    throw new HttpError(401, "Email or password is incorrect");
  }
  if (user.banned) throw new HttpError(403, "This account has been suspended");
  startSession(res, user);
  save();
  send(res, 200, meView(user));
}

function logout(req, res) {
  const token = parseCookies(req).bd_session;
  if (token) { delete db.sessions[sha256(token)]; save(); }
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  send(res, 200, { ok: true });
}

// ---------- API: bills ----------

function listBills(url) {
  const category = url.searchParams.get("category");
  const status = url.searchParams.get("status") || "open"; // open | paid | all
  const sort = url.searchParams.get("sort") || "newest";

  // Only reviewed bills are ever public.
  let bills = db.bills.filter((b) => b.status === "verified").map(publicBill);
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
  const live = db.bills.filter((b) => b.status === "verified");
  const totals = new Map(); // patronId -> named giving (anonymous gifts count toward tier, not the public board)
  for (const b of live) for (const c of b.contributions) {
    if (!c.anonymous) totals.set(c.patronId, (totals.get(c.patronId) || 0) + c.amountCents);
  }
  const leaderboard = [...totals.entries()]
    .map(([id, amountCents]) => {
      const u = db.users.find((x) => x.id === id);
      return u && !u.banned ? { patron: u.displayName, tier: tierFor(givenBy(id)).id, amountCents } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 10);
  return {
    totalPaidCents: live.reduce((s, b) => s + paidCents(b), 0),
    billsPaidOff: live.filter(isPaidOff).length,
    openNeedCents: live.filter((b) => !isPaidOff(b)).reduce((s, b) => s + b.amountCents - paidCents(b), 0),
    leaderboard,
    tiers: TIERS,
  };
}

async function createBill(req, res) {
  const user = requireUser(req, "member");
  const me = meView(user);
  if (!me.canSubmit) throw new HttpError(403, me.cantSubmitReason);

  const body = await readJson(req, MAX_UPLOAD_BODY);
  if (body.attest !== true) throw new HttpError(400, "Please confirm the bill is real and yours");
  const category = str(body.category, "Category", { max: 20 });
  if (!CATEGORIES.includes(category)) throw new HttpError(400, "Unknown category");
  let dueDate = null;
  if (body.dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) || Number.isNaN(Date.parse(body.dueDate))) {
      throw new HttpError(400, "Due date must be YYYY-MM-DD");
    }
    dueDate = body.dueDate;
  }
  const accountLast4 = str(body.accountLast4, "Last 4 of the account number", { max: 4 });
  if (!/^\d{4}$/.test(accountLast4)) throw new HttpError(400, "Enter the last 4 digits of the account number on your statement");

  const bill = {
    id: uuid(),
    ownerId: user.id,
    title: assertNoPII(str(body.title, "Title", { min: 4, max: 80 }), "Title"),
    story: assertNoPII(str(body.story, "Story", { min: 10, max: 1000 }), "Story"),
    category,
    amountCents: cents(body.amount, "Amount", { min: 100, max: POLICY.maxBillCents }),
    biller: str(body.biller, "Who the bill is owed to", { min: 2, max: 80 }),
    accountLast4,
    name: user.displayName.split(/\s+/)[0], // first name only, ever
    city: assertNoPII(str(body.city, "City or region", { max: 60, required: false }), "City or region"),
    dueDate,
    document: null,
    status: "pending",
    reviewNote: "",
    reports: [],
    createdAt: new Date().toISOString(),
    verifiedAt: null,
    contributions: [],
  };
  const { buf, meta } = parseDocument(body.document);
  rateLimit("bill:" + user.id, 5, 60 * 60000); // counts only submissions that passed validation
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, meta.file), buf);
  bill.document = meta;

  db.bills.push(bill);
  save();
  send(res, 201, ownerBill(bill));
}

async function payBill(req, res, id) {
  const user = requireUser(req, "patron");
  rateLimit("pay:" + user.id, 30, 60 * 60000);
  const body = await readJson(req);
  const bill = db.bills.find((b) => b.id === id && b.status === "verified");
  if (!bill) throw new HttpError(404, "Bill not found");
  const remaining = bill.amountCents - paidCents(bill);
  if (remaining <= 0) throw new HttpError(409, "This bill is already settled");

  const amountCents = body.payInFull ? remaining : cents(body.amount, "Amount", { min: 100, max: remaining });
  bill.contributions.push({
    id: uuid(),
    patronId: user.id,
    patronName: user.displayName,
    anonymous: body.anonymous === true,
    amountCents,
    message: assertNoPII(str(body.message, "Message", { max: 280, required: false }), "Message"),
    payee: bill.biller, // funds are always routed to the biller, never the member
    createdAt: new Date().toISOString(),
  });
  save();
  const total = givenBy(user.id);
  const receipt = receiptView(user, bill, bill.contributions[bill.contributions.length - 1]);
  send(res, 200, { bill: publicBill(bill), givenCents: total, tier: tierFor(total), receipt });
}

async function reportBill(req, res, id) {
  const user = requireUser(req);
  const body = await readJson(req);
  const bill = db.bills.find((b) => b.id === id && b.status === "verified");
  if (!bill) throw new HttpError(404, "Bill not found");
  if (bill.ownerId === user.id) throw new HttpError(400, "You can't report your own bill");
  if (bill.reports.some((r) => r.userId === user.id)) throw new HttpError(409, "You've already reported this bill");
  const reasons = ["fake", "duplicate", "inappropriate", "other"];
  if (!reasons.includes(body.reason)) throw new HttpError(400, "Choose a reason");
  bill.reports.push({
    userId: user.id, reason: body.reason,
    details: str(body.details, "Details", { max: 500, required: false }),
    createdAt: new Date().toISOString(),
  });
  if (bill.reports.length >= POLICY.reportsToFlag && !isPaidOff(bill)) {
    bill.status = "flagged"; // hidden from the feed until a reviewer looks again
  }
  save();
  send(res, 200, { ok: true });
}

// ---------- API: the deck (swipe to settle or pass) ----------

// Open, verified bills this patron hasn't passed on. Most urgent first, then newest.
function deck(req) {
  const user = currentUser(req);
  const passed = new Set(user?.passed || []);
  return db.bills
    .filter((b) => b.status === "verified" && !isPaidOff(b) && !passed.has(b.id))
    .map(publicBill)
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.createdAt.localeCompare(a.createdAt));
}

async function passBill(req, res, id) {
  const user = requireUser(req, "patron");
  if (!db.bills.some((b) => b.id === id && b.status === "verified")) throw new HttpError(404, "Bill not found");
  user.passed = [...new Set([...(user.passed || []), id])].slice(-5000);
  save();
  send(res, 200, { ok: true });
}

function resetDeck(req, res) {
  const user = requireUser(req, "patron");
  user.passed = [];
  save();
  send(res, 200, { ok: true });
}

// ---------- API: dashboards ----------

function myBills(req) {
  const user = requireUser(req, "member");
  return db.bills.filter((b) => b.ownerId === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(ownerBill);
}

function myGiving(req) {
  const user = requireUser(req, "patron");
  const out = [];
  for (const b of db.bills) for (const c of b.contributions) {
    if (c.patronId === user.id) out.push({ ...contributionView(c), anonymous: c.anonymous, billId: b.id, billTitle: b.title, billPaidOff: isPaidOff(b) });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- API: patron paperwork (receipts, annual statement, CSV) ----------

const receiptNo = (c) => `BD-${c.createdAt.slice(0, 4)}-${c.id.slice(0, 8).toUpperCase()}`;
const treatmentOf = (bill) => (bill.category === "medical" ? "medical" : "gift");

function patronGifts(user, year) {
  const out = [];
  for (const b of db.bills) for (const c of b.contributions) {
    if (c.patronId !== user.id) continue;
    if (year && !c.createdAt.startsWith(String(year))) continue;
    out.push({ bill: b, c });
  }
  return out.sort((x, y) => x.c.createdAt.localeCompare(y.c.createdAt));
}

function receiptView(user, bill, c) {
  return {
    id: c.id,
    receiptNo: receiptNo(c),
    date: c.createdAt,
    amountCents: c.amountCents,
    payer: { name: user.displayName, email: user.email },
    payee: c.payee,
    onBehalfOf: `${bill.name}${bill.city ? ", " + bill.city : ""}`,
    billTitle: bill.title,
    category: bill.category,
    treatment: treatmentOf(bill),
    anonymous: c.anonymous,
  };
}

function taxSummary(user, year) {
  const gifts = patronGifts(user, year);
  const limit = exclusionFor(year);
  const byRecipient = new Map();
  for (const { bill, c } of gifts) {
    const r = byRecipient.get(bill.ownerId) || { recipient: `${bill.name}${bill.city ? ", " + bill.city : ""}`, medicalCents: 0, giftCents: 0 };
    if (treatmentOf(bill) === "medical") r.medicalCents += c.amountCents; else r.giftCents += c.amountCents;
    byRecipient.set(bill.ownerId, r);
  }
  const recipients = [...byRecipient.values()].map((r) => ({ ...r, overExclusion: r.giftCents > limit, overByCents: Math.max(0, r.giftCents - limit) }));
  const sum = (k) => recipients.reduce((s, r) => s + r[k], 0);
  return {
    year,
    annualExclusionCents: limit,
    totalCents: sum("medicalCents") + sum("giftCents"),
    medicalCents: sum("medicalCents"),
    giftCents: sum("giftCents"),
    form709Likely: recipients.some((r) => r.overExclusion),
    recipients,
    receipts: gifts.map(({ bill, c }) => receiptView(user, bill, c)),
    years: [...new Set(patronGifts(user).map(({ c }) => Number(c.createdAt.slice(0, 4))))].sort((a, b) => b - a),
  };
}

function yearParam(url) {
  const y = Number(url.searchParams.get("year") || new Date().getFullYear());
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, "Invalid year");
  return y;
}

function taxCsv(req, res, url) {
  const user = requireUser(req, "patron");
  const t = taxSummary(user, yearParam(url));
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Receipt", "Date", "Amount (USD)", "Paid to", "On behalf of", "Bill", "Category", "Gift-tax treatment"]];
  for (const r of t.receipts) {
    rows.push([r.receiptNo, r.date.slice(0, 10), (r.amountCents / 100).toFixed(2), r.payee, r.onBehalfOf, r.billTitle, r.category,
      r.treatment === "medical" ? "Medical paid directly to provider (IRC 2503(e))" : "Gift to individual (annual exclusion)"]);
  }
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="billdrop-${t.year}-gifts.csv"`,
    "Cache-Control": "private, no-store",
  });
  res.end(rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n");
}

// Shown in the settle sheet before paying, so the patron knows the tax picture up front.
function taxPreview(req, id) {
  const user = requireUser(req, "patron");
  const bill = db.bills.find((b) => b.id === id && b.status === "verified");
  if (!bill) throw new HttpError(404, "Bill not found");
  const year = new Date().getFullYear();
  let toRecipient = 0;
  for (const { bill: b, c } of patronGifts(user, year)) {
    if (b.ownerId === bill.ownerId && treatmentOf(b) === "gift") toRecipient += c.amountCents;
  }
  return { treatment: treatmentOf(bill), year, annualExclusionCents: exclusionFor(year), givenToRecipientThisYearCents: toRecipient };
}

// ---------- API: review ----------

function reviewQueue(req) {
  requireUser(req, "admin");
  const order = { flagged: 0, pending: 1 };
  return db.bills.filter((b) => b.status in order)
    .sort((a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt))
    .map(adminBill);
}

function serveDocument(req, res, id) {
  requireUser(req, "admin");
  const bill = db.bills.find((b) => b.id === id);
  if (!bill?.document?.file) throw new HttpError(404, "No statement on file");
  const file = path.join(UPLOAD_DIR, bill.document.file);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "File missing" });
    res.writeHead(200, {
      "Content-Type": bill.document.mime,
      "Content-Disposition": `inline; filename="${bill.document.name.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    });
    res.end(data);
  });
}

// Statements are only needed for the review itself. Delete the file once a decision is made and
// keep just the hash (to catch the same statement being resubmitted).
function purgeDocument(bill) {
  if (!bill.document?.file) return;
  fs.rmSync(path.join(UPLOAD_DIR, bill.document.file), { force: true });
  bill.document = { hash: bill.document.hash, purgedAt: new Date().toISOString() };
}

async function review(req, res, id) {
  const admin = requireUser(req, "admin");
  const body = await readJson(req);
  const bill = db.bills.find((b) => b.id === id);
  if (!bill) throw new HttpError(404, "Bill not found");
  if (bill.status !== "pending" && bill.status !== "flagged") throw new HttpError(409, "This bill isn't awaiting review");
  const note = str(body.note, "Note", { max: 500, required: false });

  if (body.decision === "approve") {
    bill.status = "verified";
    bill.verifiedAt = new Date().toISOString();
    bill.reports = []; // reviewed; start counting fresh
  } else if (body.decision === "reject" || body.decision === "ban") {
    if (!note) throw new HttpError(400, "Add a note so the member knows why");
    bill.status = "rejected";
    if (body.decision === "ban") {
      const owner = db.users.find((u) => u.id === bill.ownerId);
      if (owner) {
        owner.banned = true;
        for (const [k, s] of Object.entries(db.sessions)) if (s.userId === owner.id) delete db.sessions[k];
        for (const b of db.bills) {
          if (b.ownerId === owner.id && b.status !== "rejected" && !isPaidOff(b)) {
            b.status = "rejected";
            b.reviewNote = b.reviewNote || "Account suspended";
            purgeDocument(b);
          }
        }
      }
    }
  } else {
    throw new HttpError(400, "Decision must be approve, reject or ban");
  }
  bill.reviewNote = note || bill.reviewNote;
  bill.reviewedBy = admin.id;
  purgeDocument(bill);
  save();
  send(res, 200, adminBill(bill));
}

// ---------- router ----------

async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  let match;

  if (m === "GET" && p === "/api/categories") return send(res, 200, CATEGORIES);
  if (m === "GET" && p === "/api/stats") return send(res, 200, stats());
  if (m === "GET" && p === "/api/policy") return send(res, 200, POLICY);

  if (m === "POST" && p === "/api/auth/signup") return signup(req, res);
  if (m === "POST" && p === "/api/auth/login") return login(req, res);
  if (m === "POST" && p === "/api/auth/logout") return logout(req, res);
  if (m === "GET" && p === "/api/me") {
    const u = currentUser(req);
    return send(res, 200, u ? meView(u) : null);
  }

  if (m === "GET" && p === "/api/bills") {
    rateLimit("feed:" + clientIp(req), 120, 60000); // slows bulk scraping
    return send(res, 200, listBills(url));
  }
  if (m === "POST" && p === "/api/bills") return createBill(req, res);
  if ((match = p.match(/^\/api\/bills\/([\w-]+)$/)) && m === "GET") {
    const bill = db.bills.find((b) => b.id === match[1] && b.status === "verified");
    if (!bill) throw new HttpError(404, "Bill not found");
    return send(res, 200, publicBill(bill));
  }
  if ((match = p.match(/^\/api\/bills\/([\w-]+)\/pay$/)) && m === "POST") return payBill(req, res, match[1]);
  if ((match = p.match(/^\/api\/bills\/([\w-]+)\/report$/)) && m === "POST") return reportBill(req, res, match[1]);
  if ((match = p.match(/^\/api\/bills\/([\w-]+)\/pass$/)) && m === "POST") return passBill(req, res, match[1]);
  if (m === "GET" && p === "/api/deck") {
    rateLimit("feed:" + clientIp(req), 120, 60000);
    return send(res, 200, deck(req));
  }
  if (m === "POST" && p === "/api/deck/reset") return resetDeck(req, res);

  if (m === "GET" && p === "/api/my/bills") return send(res, 200, myBills(req));
  if (m === "GET" && p === "/api/my/giving") return send(res, 200, myGiving(req));
  if (m === "GET" && p === "/api/my/tax") return send(res, 200, taxSummary(requireUser(req, "patron"), yearParam(url)));
  if (m === "GET" && p === "/api/my/tax.csv") return taxCsv(req, res, url);
  if ((match = p.match(/^\/api\/my\/receipts\/([\w-]+)$/)) && m === "GET") {
    const user = requireUser(req, "patron");
    const hit = patronGifts(user).find(({ c }) => c.id === match[1]);
    if (!hit) throw new HttpError(404, "Receipt not found");
    return send(res, 200, receiptView(user, hit.bill, hit.c));
  }
  if ((match = p.match(/^\/api\/bills\/([\w-]+)\/tax-preview$/)) && m === "GET") return send(res, 200, taxPreview(req, match[1]));

  if (m === "GET" && p === "/api/admin/queue") return send(res, 200, reviewQueue(req));
  if ((match = p.match(/^\/api\/admin\/bills\/([\w-]+)\/document$/)) && m === "GET") return serveDocument(req, res, match[1]);
  if ((match = p.match(/^\/api\/admin\/bills\/([\w-]+)\/review$/)) && m === "POST") return review(req, res, match[1]);

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
    res.writeHead(200, {
      "Content-Type": (MIME[path.extname(file)] || "application/octet-stream") + "; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    });
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
    if (res.headersSent) return;
    if (err instanceof HttpError) send(res, err.status, { error: err.message });
    else { console.error(err); send(res, 500, { error: "Something went wrong" }); }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`BillDrop running at http://localhost:${PORT}`);
    if (!ADMIN_EMAILS.length) console.log("Tip: set ADMIN_EMAILS=you@example.com to get a reviewer account when you sign up with that email.");
  });
}

module.exports = { server, POLICY, TIERS };
