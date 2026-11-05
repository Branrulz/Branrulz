const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { me: null, status: "open", category: "", sort: "newest", bills: [], tiers: [], categories: [] };

const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const label = (cat) => cat.replace("-", " ").replace(/\b\w/g, (m) => m.toUpperCase());
const tierName = (id) => state.tiers.find((t) => t.id === id)?.name || "";
const tierChip = (id) => id && id !== "patron" ? `<span class="tier-chip tier-${esc(id)}">${esc(tierName(id))}</span>` : "";
const isRole = (r) => state.me?.role === r;

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function due(dateStr) {
  if (!dateStr) return "";
  const days = Math.ceil((Date.parse(dateStr + "T23:59:59") - Date.now()) / 86400000);
  if (days < 0) return `<span class="due overdue">Overdue</span>`;
  if (days <= 7) return `<span class="due soon">Due in ${days}d</span>`;
  return `<span class="due">Due ${esc(dateStr)}</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me) { state.me = null; renderNav(); }
    throw new Error(data?.error || "Request failed");
  }
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3800);
}

function showError(form, msg) {
  const el = $(".error", form);
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---------- nav ----------

function renderNav() {
  const me = state.me;
  let html = "";
  if (!me) {
    html = `<a class="btn btn-link" href="#/deck">The Deck</a>
            <button class="btn btn-link" data-auth="signin">Sign in</button>
            <button class="btn btn-ghost" data-auth="join">Join</button>`;
  } else {
    const where = me.role === "admin" ? `<a class="btn btn-link" href="#/review">Review queue</a>`
      : `<a class="btn btn-link" href="#/ledger">${me.role === "patron" ? "My standing" : "My bills"}</a>`;
    html = `<span class="who-am-i">${esc(me.displayName)} ${me.role === "patron" ? tierChip(me.tier.id) : ""}</span>
            ${me.role === "patron" ? `<a class="btn btn-link" href="#/deck">The Deck</a>` : ""}
            ${where}
            ${me.role === "member" ? `<button class="btn btn-ghost" data-action="submit-bill">Submit a bill</button>` : ""}
            <button class="btn btn-link" data-action="logout">Sign out</button>`;
  }
  $("#nav-actions").innerHTML = html;

  $("#hero-ctas").innerHTML = !me
    ? `<a class="btn btn-primary" href="#/deck">Open the Deck</a>
       <button class="btn btn-ghost" data-auth="join" data-role="patron">Become a patron</button>
       <button class="btn btn-ghost" data-auth="join" data-role="member">I have a bill</button>`
    : me.role === "member"
      ? `<button class="btn btn-primary" data-action="submit-bill">Submit a bill</button>`
      : me.role === "patron" ? `<a class="btn btn-primary" href="#/deck">Open the Deck</a>` : "";
}

// ---------- feed ----------

function billCard(b) {
  const pct = Math.min(100, Math.round((b.paidCents / b.amountCents) * 100));
  const latest = b.contributions.slice(-2).reverse();
  let action = "";
  if (!b.paidOff) {
    if (!state.me || isRole("patron")) action = `<button class="btn btn-primary btn-block" data-pay="${esc(b.id)}">Settle this account</button>`;
    else if (isRole("member")) action = `<p class="patrons-only">Settled by patrons only</p>`;
  }
  const canReport = state.me && !isRole("admin") && !b.paidOff;
  return `
    <article class="bill ${b.paidOff ? "paid" : ""}">
      <div class="bill-head">
        <span class="cat">${esc(label(b.category))}${b.verified ? ` <span class="verified" title="Statement checked by a BillDrop reviewer">✓ Verified</span>` : ""}</span>
        ${b.paidOff ? `<span class="stamp">Settled</span>` : due(b.dueDate)}
      </div>
      <h3>${esc(b.title)}</h3>
      <p class="who">${esc(b.name)}${b.city ? " · " + esc(b.city) : ""} · ${ago(b.createdAt)}</p>
      <p class="story">${esc(b.story)}</p>
      <p class="biller">Paid directly to <strong>${esc(b.biller)}</strong></p>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="amounts">
        <span><strong>${money(b.paidCents)}</strong> of ${money(b.amountCents)}</span>
        <span>${b.paidOff ? "Settled in full" : money(b.remainingCents) + " outstanding"}</span>
      </div>
      ${latest.length ? `<ul class="contribs">${latest.map((c) => `<li><strong>${esc(c.patron)}</strong> ${tierChip(c.tier)} gave ${money(c.amountCents)}${c.message ? ` — <q>${esc(c.message)}</q>` : ""}</li>`).join("")}</ul>` : ""}
      ${action}
      ${canReport ? `<button class="report-link" data-report="${esc(b.id)}">Report</button>` : ""}
    </article>`;
}

async function loadFeed() {
  const q = new URLSearchParams({ status: state.status, sort: state.sort });
  if (state.category) q.set("category", state.category);
  try {
    state.bills = await api("/bills?" + q);
    $("#feed").innerHTML = state.bills.length
      ? state.bills.map(billCard).join("")
      : `<p class="empty">${state.status === "paid" ? "No accounts settled yet. The ledger awaits its first patron." : "The ledger is quiet. Submit the first bill."}</p>`;
  } catch (e) {
    $("#feed").innerHTML = `<p class="empty">Couldn't load bills: ${esc(e.message)}</p>`;
  }
}

async function loadStats() {
  const s = await api("/stats");
  state.tiers = s.tiers;
  $("#stat-paid").textContent = money(s.totalPaidCents);
  $("#stat-count").textContent = s.billsPaidOff;
  $("#stat-need").textContent = money(s.openNeedCents);
  $("#leaderboard").innerHTML = s.leaderboard.length
    ? s.leaderboard.map((p) => `<li><span>${esc(p.patron)}</span>${tierChip(p.tier)}<strong>${money(p.amountCents)}</strong></li>`).join("")
    : `<li class="empty-small">A seat at the head of the table remains open.</li>`;
  const holders = (id) => s.leaderboard.filter((p) => p.tier === id).length;
  $("#tier-ladder").innerHTML = [...s.tiers].reverse().map((t) => `
    <li><span class="tier-swatch tier-${t.id}"></span><span class="tier-label">${esc(t.name)}</span>
    <span class="tier-min">${t.minCents ? money(t.minCents) + "+" : "Entry"}</span>
    ${t.id === "black" && !holders("black") ? `<span class="tier-unclaimed">Unclaimed</span>` : ""}</li>`).join("");
}

const refreshFeed = () => Promise.all([loadFeed(), loadStats()]);

// ---------- membership card & dashboards ----------

function memberCard(me) {
  const t = me.tier;
  const next = t.next;
  const pct = next ? Math.min(100, Math.round(((me.givenCents - t.minCents) / (next.minCents - t.minCents)) * 100)) : 100;
  return `
    <div class="member-card tier-${esc(t.id)}">
      <div class="mc-top"><span class="mc-brand">BillDrop</span><span class="mc-tier">${esc(t.name)}</span></div>
      <div class="mc-chip" aria-hidden="true"></div>
      <div class="mc-bottom">
        <div><span class="mc-label">Patron</span><span class="mc-name">${esc(me.displayName)}</span></div>
        <div><span class="mc-label">Member since</span><span class="mc-since">${new Date(me.createdAt).getFullYear()}</span></div>
      </div>
    </div>
    <div class="standing">
      <span class="eyebrow">Lifetime giving</span>
      <p class="standing-total">${money(me.givenCents)}</p>
      ${next ? `
        <div class="progress"><span style="width:${pct}%"></span></div>
        <p class="standing-next">${money(next.toGoCents)} more to reach <strong>${esc(next.name)}</strong></p>`
      : `<p class="standing-next">You hold the highest standing in the Circle.</p>`}
    </div>`;
}

async function renderPatronLedger(el) {
  const [me, giving] = await Promise.all([api("/me"), api("/my/giving")]);
  state.me = me;
  renderNav();
  el.innerHTML = `
    <span class="eyebrow">Your standing</span>
    <h1 class="page-title">Welcome back, ${esc(me.displayName)}.</h1>
    <div class="patron-grid">
      <section>${memberCard(me)}</section>
      <section class="card">
        <span class="eyebrow">Ledger</span>
        <h2>Accounts you've settled</h2>
        ${giving.length ? `<ul class="history">${giving.map((g) => `
          <li><div><strong>${esc(g.billTitle)}</strong>
            <span class="muted-line">${ago(g.createdAt)} · paid to ${esc(g.payee)}${g.anonymous ? " · anonymous" : ""}${g.billPaidOff ? " · settled" : ""}</span></div>
            <span class="history-amt">${money(g.amountCents)}</span></li>`).join("")}</ul>`
        : `<p class="empty-small">Nothing yet. <a href="#/">Browse open accounts</a> to make your first gesture.</p>`}
      </section>
    </div>`;
}

const STATUS = {
  pending: ["Under review", "Our reviewers are checking your statement with the biller."],
  verified: ["Live", "Patrons can see and settle this bill."],
  flagged: ["Re-review", "Patrons raised concerns; a reviewer will take another look."],
  rejected: ["Not approved", ""],
};

async function renderMemberLedger(el) {
  const [me, bills] = await Promise.all([api("/me"), api("/my/bills")]);
  state.me = me;
  renderNav();
  el.innerHTML = `
    <div class="page-head">
      <div><span class="eyebrow">Your bills</span><h1 class="page-title">Hello, ${esc(me.displayName)}.</h1></div>
      ${me.canSubmit ? `<button class="btn btn-primary" data-action="submit-bill">Submit a bill</button>` : `<p class="notice">${esc(me.cantSubmitReason)}</p>`}
    </div>
    <div class="safety">
      <span class="eyebrow">Protect yourself</span>
      <ul>
        <li>Patrons pay your biller directly. You never need to share anything with a patron.</li>
        <li>BillDrop staff and patrons will <strong>never</strong> contact you by phone, text or social media, or ask for your SSN, bank login, fees or gift cards.</li>
        <li>If anyone says they're a BillDrop patron and asks for your details, it's a scam. Don't reply.</li>
      </ul>
    </div>
    <div class="feed">${bills.length ? bills.map((b) => {
      const [name, desc] = b.paidOff ? ["Settled", "Paid in full to your biller."] : STATUS[b.status];
      const pct = Math.min(100, Math.round((b.paidCents / b.amountCents) * 100));
      return `<article class="bill">
        <div class="bill-head"><span class="cat">${esc(label(b.category))}</span><span class="status status-${b.paidOff ? "settled" : b.status}">${name}</span></div>
        <h3>${esc(b.title)}</h3>
        <p class="who">Submitted ${ago(b.createdAt)} · ${esc(b.biller)} ·· ${esc(b.accountLast4)}</p>
        <p class="story">${esc(b.status === "rejected" ? "Reviewer's note: " + (b.reviewNote || "—") : desc)}</p>
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="amounts"><span><strong>${money(b.paidCents)}</strong> of ${money(b.amountCents)}</span><span>${b.contributions.length} patron${b.contributions.length === 1 ? "" : "s"}</span></div>
      </article>`;
    }).join("") : `<p class="empty">You haven't submitted a bill yet.</p>`}</div>`;
}

async function renderReview(el) {
  const queue = await api("/admin/queue");
  el.innerHTML = `
    <span class="eyebrow">Reviewer desk</span>
    <h1 class="page-title">Review queue <span class="count">${queue.length}</span></h1>
    <p class="notice">Before approving: open the statement, confirm the biller and account match, and call the biller using a number <strong>you look up yourself</strong> — never the one printed on the statement.</p>
    <div class="queue">${queue.length ? queue.map((b) => `
      <article class="card review-item" data-id="${esc(b.id)}">
        <div class="bill-head"><span class="cat">${esc(label(b.category))}</span><span class="status status-${b.status}">${b.status === "flagged" ? "Flagged by patrons" : "New submission"}</span></div>
        <h3>${esc(b.title)} — ${money(b.amountCents)}</h3>
        <p class="story">${esc(b.story)}</p>
        <dl class="facts">
          <dt>Biller</dt><dd>${esc(b.biller)} · account …${esc(b.accountLast4)}</dd>
          <dt>Member</dt><dd>${esc(b.owner?.displayName)} · ${esc(b.owner?.email)} · joined ${ago(b.owner?.createdAt)} · ${b.owner?.otherBills} other bill(s), ${b.owner?.rejectedBills} rejected</dd>
          <dt>Statement</dt><dd>${b.hasDocument ? `<a href="/api/admin/bills/${esc(b.id)}/document" target="_blank" rel="noopener">${esc(b.documentName)}</a>` : "None"}</dd>
          ${b.dueDate ? `<dt>Due</dt><dd>${esc(b.dueDate)}</dd>` : ""}
        </dl>
        ${b.signals.length ? `<ul class="signals">${b.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
        ${b.reports.length ? `<div class="reports"><span class="eyebrow">Reports (${b.reports.length})</span><ul>${b.reports.map((r) => `<li><strong>${esc(r.reason)}</strong>${r.details ? " — " + esc(r.details) : ""}</li>`).join("")}</ul></div>` : ""}
        <label>Note to member <small>(required to reject)</small><input name="note" maxlength="500"></label>
        <p class="error" hidden></p>
        <div class="actions">
          <button class="btn btn-danger" data-decision="ban">Reject &amp; ban</button>
          <button class="btn btn-ghost" data-decision="reject">Reject</button>
          <button class="btn btn-primary" data-decision="approve">Approve</button>
        </div>
      </article>`).join("") : `<p class="empty">All caught up. Nothing awaits review.</p>`}</div>`;
}

// ---------- routing ----------

async function route() {
  const r = location.hash.replace(/^#/, "") || "/";
  const views = { "/": "view-feed", "/deck": "view-deck", "/ledger": "view-ledger", "/review": "view-review" };
  let view = views[r] || "view-feed";
  if ((view === "view-ledger" || view === "view-review") && !state.me) view = "view-feed";
  if (view === "view-deck" && state.me && !isRole("patron")) view = "view-feed";
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  window.scrollTo(0, 0);
  try {
    if (view === "view-feed") await refreshFeed();
    if (view === "view-deck") await loadDeck();
    if (view === "view-ledger") {
      if (isRole("admin")) return void (location.hash = "#/review");
      await (isRole("patron") ? renderPatronLedger : renderMemberLedger)($("#view-ledger"));
    }
    if (view === "view-review") {
      if (!isRole("admin")) return void (location.hash = "#/");
      await renderReview($("#view-review"));
    }
  } catch (e) {
    toast(e.message);
  }
}
window.addEventListener("hashchange", route);

// ---------- auth ----------

const authForm = $("#auth-form");
let authMode = "join";

function setAuthMode(mode, role) {
  authMode = mode;
  $$(".auth-switch .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $$("[data-join]", authForm).forEach((el) => (el.hidden = mode !== "join"));
  $("#auth-submit").textContent = mode === "join" ? "Join" : "Sign in";
  authForm.password.autocomplete = mode === "join" ? "new-password" : "current-password";
  if (role) authForm.role.value = role;
  updateNameLabel();
  showError(authForm, "");
}
function updateNameLabel() {
  $("#name-label").textContent = authForm.role.value === "member" ? "First name" : "Name shown in the Circle";
}
function openAuth(mode, role) {
  authForm.reset();
  setAuthMode(mode, role || "patron");
  $("#auth-dialog").showModal();
}
$$(".auth-switch .tab").forEach((t) => t.addEventListener("click", () => setAuthMode(t.dataset.mode)));
$$("input[name=role]", authForm).forEach((r) => r.addEventListener("change", updateNameLabel));

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = authForm;
  try {
    const body = { email: f.email.value, password: f.password.value };
    if (authMode === "join") Object.assign(body, { role: f.role.value, displayName: f.displayName.value });
    state.me = await api(authMode === "join" ? "/auth/signup" : "/auth/login", { method: "POST", body });
    $("#auth-dialog").close();
    renderNav();
    toast(authMode === "join"
      ? ({ patron: `Welcome to the Circle, ${state.me.displayName}.`, member: `Welcome, ${state.me.displayName}. You may now submit a bill.`, admin: "Reviewer access granted." })[state.me.role]
      : `Welcome back, ${state.me.displayName}.`);
    if (state.me.role === "admin") location.hash = "#/review";
    else route();
  } catch (err) { showError(f, err.message); }
});

// ---------- global clicks ----------

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-auth],[data-action],[data-close],[data-pay],[data-report],[data-decision],[data-swipe]");
  if (!t) return;

  if (t.dataset.auth) return openAuth(t.dataset.auth, t.dataset.role);
  if (t.hasAttribute("data-close")) return t.closest("dialog").close();

  if (t.dataset.action === "logout") {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => {});
    state.me = null;
    renderNav();
    location.hash = "#/";
    route();
    return toast("You've signed out.");
  }
  if (t.dataset.action === "submit-bill") return openPost();
  if (t.dataset.swipe) return swipe(t.dataset.swipe);
  if (t.dataset.action === "reset-deck") {
    await api("/deck/reset", { method: "POST", body: {} });
    return loadDeck();
  }
  if (t.dataset.pay) return openPay(t.dataset.pay);
  if (t.dataset.report) return openReport(t.dataset.report);
  if (t.dataset.decision) return decide(t);
});

// ---------- submit a bill ----------

const postForm = $("#post-form");

function openPost() {
  if (!state.me) return openAuth("join", "member");
  if (!isRole("member")) return;
  if (state.me.canSubmit === false) return toast(state.me.cantSubmitReason);
  postForm.reset();
  showError(postForm, "");
  $("#post-dialog").showModal();
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read that file"));
    r.readAsDataURL(file);
  });
}

postForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = postForm;
  const file = f.document.files[0];
  if (!file) return showError(f, "Please attach your statement or invoice");
  if (file.size > 4 * 1024 * 1024) return showError(f, "Statement must be 4 MB or smaller");
  if (!f.attest.checked) return showError(f, "Please confirm the bill is real and yours");
  const submit = $("button[type=submit]", f);
  submit.disabled = true;
  try {
    const body = {
      title: f.title.value, story: f.story.value, amount: f.amount.value, category: f.category.value,
      biller: f.biller.value, accountLast4: f.accountLast4.value, city: f.city.value, dueDate: f.dueDate.value,
      attest: true, document: { name: file.name, data: await readFileBase64(file) },
    };
    await api("/bills", { method: "POST", body });
    $("#post-dialog").close();
    toast("Submitted. A reviewer will verify it before it goes live.");
    location.hash = "#/ledger";
    route();
  } catch (err) { showError(f, err.message); }
  finally { submit.disabled = false; }
});

// ---------- settle ----------

let payingId = null;
const payForm = $("#pay-form");

function openPay(id) {
  if (!state.me) return openAuth("join", "patron");
  if (!isRole("patron")) return;
  const bill = findBill(id);
  if (!bill) return;
  payingId = bill.id;
  payForm.reset();
  showError(payForm, "");
  $("#pay-title").textContent = bill.title;
  $("#pay-remaining").textContent = `${money(bill.remainingCents)} outstanding, paid directly to ${bill.biller}.`;
  payForm.amount.max = (bill.remainingCents / 100).toFixed(2);
  payForm.amount.value = (bill.remainingCents / 100).toFixed(2);
  payForm.amount.disabled = false;
  $("#pay-dialog").showModal();
}

payForm.payInFull.addEventListener("change", () => {
  const bill = findBill(payingId);
  payForm.amount.disabled = payForm.payInFull.checked;
  if (payForm.payInFull.checked && bill) payForm.amount.value = (bill.remainingCents / 100).toFixed(2);
});

payForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const before = state.me?.tier?.id;
  try {
    const res = await api(`/bills/${payingId}/pay`, {
      method: "POST",
      body: { amount: payForm.amount.value, payInFull: payForm.payInFull.checked, anonymous: payForm.anonymous.checked, message: payForm.message.value },
    });
    $("#pay-dialog").close();
    state.me = { ...state.me, givenCents: res.givenCents, tier: res.tier };
    renderNav();
    if (res.tier.id !== before) toast(`You've risen to ${res.tier.name}. The Circle takes note.`);
    else toast(res.bill.paidOff ? "Account settled. Most generous." : `Received with gratitude. ${money(res.bill.remainingCents)} remains.`);
    if (deckPending === payingId) { deckPending = null; state.deck.shift(); renderDeck(); }
    else refreshFeed();
  } catch (err) { showError(payForm, err.message); }
});

// ---------- the deck (swipe to settle or pass) ----------

state.deck = [];
let deckPending = null; // bill id waiting on the settle confirmation
const findBill = (id) => state.bills.find((b) => b.id === id) || state.deck.find((b) => b.id === id);

async function loadDeck() {
  state.deck = await api("/deck");
  if (!state.tiers.length) state.tiers = (await api("/stats")).tiers;
  renderDeck();
}

function deckCard(b, i) {
  const pct = Math.min(100, Math.round((b.paidCents / b.amountCents) * 100));
  return `
    <article class="deck-card" data-id="${esc(b.id)}" data-i="${i}" style="--i:${i}" ${i ? 'aria-hidden="true"' : ""}>
      <span class="deck-stamp deck-stamp-settle">Settle</span>
      <span class="deck-stamp deck-stamp-pass">Pass</span>
      <div class="bill-head">
        <span class="cat">${esc(label(b.category))} <span class="verified">✓ Verified</span></span>
        ${due(b.dueDate)}
      </div>
      <h2>${esc(b.title)}</h2>
      <p class="who">${esc(b.name)}${b.city ? " · " + esc(b.city) : ""} · ${ago(b.createdAt)}</p>
      <p class="deck-story">${esc(b.story)}</p>
      <div class="deck-amount">
        <span class="eyebrow">Outstanding</span>
        <strong>${money(b.remainingCents)}</strong>
        <span class="muted-line">Paid directly to ${esc(b.biller)}${b.paidCents ? ` · ${money(b.paidCents)} already given` : ""}</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </article>`;
}

function renderDeck() {
  const el = $("#deck");
  const top = state.deck.slice(0, 3);
  $("#deck-actions").hidden = !top.length;
  $("#deck-count").textContent = state.deck.length ? `${state.deck.length} open account${state.deck.length === 1 ? "" : "s"}` : "";
  if (!top.length) {
    el.innerHTML = `<div class="deck-empty">
      <p class="empty">You've seen every open account.</p>
      ${isRole("patron") ? `<button class="btn btn-ghost" data-action="reset-deck">Revisit the ones I passed</button>` : ""}
      <a class="btn btn-link" href="#/">Back to the ledger</a></div>`;
    return;
  }
  el.innerHTML = top.map(deckCard).reverse().join(""); // last in DOM = on top
  attachDrag($('.deck-card[data-i="0"]', el));
}

// Pointer-driven drag on the top card.
function attachDrag(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, t0 = 0;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true; startX = e.clientX; startY = e.clientY; dx = dy = 0; t0 = performance.now();
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 18}deg)`;
    card.style.setProperty("--settle", Math.max(0, Math.min(1, dx / 110)));
    card.style.setProperty("--pass", Math.max(0, Math.min(1, -dx / 110)));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");
    const fast = Math.abs(dx) / (performance.now() - t0) > 0.6 && Math.abs(dx) > 40;
    if (dx > 110 || (fast && dx > 0)) swipe("right");
    else if (dx < -110 || (fast && dx < 0)) swipe("left");
    else { card.style.transform = ""; card.style.setProperty("--settle", 0); card.style.setProperty("--pass", 0); }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function flyOut(card, dir) {
  return new Promise((resolve) => {
    card.classList.add("leaving");
    card.style.setProperty(dir === "right" ? "--settle" : "--pass", 1);
    card.style.transform = `translate(${dir === "right" ? 140 : -140}vw, 40px) rotate(${dir === "right" ? 30 : -30}deg)`;
    setTimeout(resolve, 280);
  });
}

async function swipe(dir) {
  const card = $('#deck .deck-card[data-i="0"]');
  const bill = state.deck[0];
  if (!card || !bill || card.classList.contains("leaving")) return;

  if (dir === "left") {
    await flyOut(card, "left");
    state.deck.shift();
    renderDeck();
    if (isRole("patron")) api(`/bills/${bill.id}/pass`, { method: "POST", body: {} }).catch(() => {});
    return;
  }
  // Right: confirm before any money moves.
  if (!state.me) { renderDeck(); return openAuth("join", "patron"); }
  await flyOut(card, "right");
  deckPending = bill.id;
  openPay(bill.id);
  payForm.payInFull.checked = true;
  payForm.payInFull.dispatchEvent(new Event("change"));
}

// Cancelling the settle sheet puts the card back on top of the deck.
$("#pay-dialog").addEventListener("close", () => {
  if (deckPending && state.deck[0]?.id === deckPending) { deckPending = null; renderDeck(); }
});

document.addEventListener("keydown", (e) => {
  if ($("#view-deck").hidden || document.querySelector("dialog[open]")) return;
  if (e.key === "ArrowRight") swipe("right");
  if (e.key === "ArrowLeft") swipe("left");
});

// ---------- report ----------

let reportingId = null;
const reportForm = $("#report-form");

function openReport(id) {
  const bill = state.bills.find((b) => b.id === id);
  if (!bill) return;
  reportingId = id;
  reportForm.reset();
  showError(reportForm, "");
  $("#report-title").textContent = bill.title;
  $("#report-dialog").showModal();
}

reportForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api(`/bills/${reportingId}/report`, { method: "POST", body: { reason: reportForm.reason.value, details: reportForm.details.value } });
    $("#report-dialog").close();
    toast("Thank you. A reviewer will take a look.");
    refreshFeed();
  } catch (err) { showError(reportForm, err.message); }
});

// ---------- review ----------

async function decide(btn) {
  const item = btn.closest(".review-item");
  const decision = btn.dataset.decision;
  if (decision === "ban" && !confirm("Reject this bill and suspend the member's account? Their other open bills will be pulled too.")) return;
  try {
    await api(`/admin/bills/${item.dataset.id}/review`, { method: "POST", body: { decision, note: $("input[name=note]", item).value } });
    toast(decision === "approve" ? "Approved. The bill is now live." : decision === "ban" ? "Rejected and member suspended." : "Rejected.");
    renderReview($("#view-review"));
  } catch (err) { showError(item, err.message); }
}

// ---------- filters ----------

$$(".tabs .tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
  state.status = tab.dataset.status;
  loadFeed();
}));
$("#filter-category").addEventListener("change", (e) => { state.category = e.target.value; loadFeed(); });
$("#filter-sort").addEventListener("change", (e) => { state.sort = e.target.value; loadFeed(); });

// ---------- boot ----------

(async () => {
  const [cats, me] = await Promise.all([api("/categories"), api("/me").catch(() => null)]);
  state.me = me;
  const opts = cats.map((c) => `<option value="${c}">${label(c)}</option>`).join("");
  $("#filter-category").insertAdjacentHTML("beforeend", opts);
  postForm.category.innerHTML = opts;
  renderNav();
  route();
})();
