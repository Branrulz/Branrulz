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

// Proof that money reached the biller, shown on bills patrons have paid toward.
function paymentBadge(b) {
  if (!b.payment) return "";
  if (b.payment.state === "confirmed") return `<p class="pay-proof confirmed">✓ ${esc(b.biller)} confirmed payment${b.paidOff ? "" : ` of ${money(b.payment.confirmedCents)}`}</p>`;
  return `<p class="pay-proof">Payment on its way to ${esc(b.biller)}${b.payment.confirmedCents ? ` · ${money(b.payment.confirmedCents)} confirmed` : ""}</p>`;
}

const PAYOUT_ICON = { confirmed: "✓", refunded: "↺", failed: "!", held: "◷", sent: "→", needs_agent: "→" };
const payoutLine = (po) => po ? `<span class="po po-${esc(po.status)}">${PAYOUT_ICON[po.status] || ""} ${esc(po.statusText)}${po.status === "held" && po.releaseAt ? ` until ${new Date(po.releaseAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</span>` : "";

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
      ${paymentBadge(b)}
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
  const year = state.taxYear || new Date().getFullYear();
  const [me, giving, tax] = await Promise.all([api("/me"), api("/my/giving"), api("/my/tax?year=" + year)]);
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
            <span class="muted-line">${ago(g.createdAt)} · paid to ${esc(g.payee)}${g.anonymous ? " · anonymous" : ""} · <a href="#/receipt/${esc(g.id)}">Receipt</a></span>
            ${payoutLine(g.payout)}</div>
            <span class="history-amt">${money(g.amountCents)}</span></li>`).join("")}</ul>`
        : `<p class="empty-small">Nothing yet. <a href="#/deck">Open the Deck</a> to make your first gesture.</p>`}
      </section>
    </div>
    ${taxCard(tax)}`;
  const sel = $("#tax-year", el);
  if (sel) sel.addEventListener("change", () => { state.taxYear = Number(sel.value); renderPatronLedger(el); });
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
      const [name, desc] = b.paidOff
        ? ["Settled", b.payment?.state === "confirmed" ? "Paid in full — your biller confirmed it." : "Fully funded by patrons. The payment is on its way to your biller."]
        : STATUS[b.status];
      const pct = Math.min(100, Math.round((b.paidCents / b.amountCents) * 100));
      return `<article class="bill">
        <div class="bill-head"><span class="cat">${esc(label(b.category))}</span><span class="status status-${b.paidOff ? "settled" : b.status}">${name}</span></div>
        <h3>${esc(b.title)}</h3>
        <p class="who">Submitted ${ago(b.createdAt)} · ${esc(b.biller)} · account …${esc(b.accountLast4)}</p>
        <p class="story">${esc(b.status === "rejected" ? "Reviewer's note: " + (b.reviewNote || "—") : desc)}</p>
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="amounts"><span><strong>${money(b.paidCents)}</strong> of ${money(b.amountCents)}</span><span>${b.contributions.length} patron${b.contributions.length === 1 ? "" : "s"}</span></div>
        ${b.payouts.length ? `<div class="member-payouts"><span class="mc-label">How it reaches ${esc(b.biller)} · ${esc(b.laneName)}</span>
          <ul>${b.payouts.map((po) => `<li><span>${money(po.amountCents)}</span>${payoutLine(po)}${po.reference ? `<small>${esc(po.reference)}</small>` : ""}</li>`).join("")}</ul>
          ${b.payouts.some((po) => po.status === "sent") ? `<button class="btn btn-ghost btn-block" data-action="confirm-received" data-bill="${esc(b.id)}">My biller received it</button>` : ""}</div>` : ""}
      </article>`;
    }).join("") : `<p class="empty">You haven't submitted a bill yet.</p>`}</div>`;
}

async function renderReview(el) {
  const [queue, payouts] = await Promise.all([api("/admin/queue"), api("/admin/payouts")]);
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
          <dt>Biller</dt><dd>${esc(b.biller)} · account …${esc(b.accountLast4)}
            ${b.billerInfo ? `<br><small class="muted-line">${esc(b.billerInfo.laneName)}${b.billerInfo.remit ? ` · ${esc(remitText(b.billerInfo.remit))}` : ""}</small>` : ""}</dd>
          <dt>Member</dt><dd>${esc(b.owner?.displayName)} · ${esc(b.owner?.email)} · joined ${ago(b.owner?.createdAt)} · ${b.owner?.otherBills} other bill(s), ${b.owner?.rejectedBills} rejected</dd>
          <dt>Statement</dt><dd>${b.hasDocument ? `<a href="/api/admin/bills/${esc(b.id)}/document" target="_blank" rel="noopener">${esc(b.documentName)}</a>` : "None"}</dd>
          ${b.dueDate ? `<dt>Due</dt><dd>${esc(b.dueDate)}</dd>` : ""}
        </dl>
        ${b.signals.length ? `<ul class="signals">${b.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
        ${b.reports.length ? `<div class="reports"><span class="eyebrow">Reports (${b.reports.length})</span><ul>${b.reports.map((r) => `<li><strong>${esc(r.reason)}</strong>${r.details ? " — " + esc(r.details) : ""}</li>`).join("")}</ul></div>` : ""}
        ${b.billerInfo ? "" : `<fieldset class="map-biller">
          <legend class="eyebrow">Before approving: how will we pay this biller?</legend>
          <label>Match to a directory biller
            <select name="mapBiller"><option value="">— Not in the directory —</option>${(b.directory || []).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("")}</select></label>
          <p class="muted-line">…or enter a payment address <strong>you've verified yourself</strong> (from the biller's official website or a phone call to a number you looked up — never from the statement). They'll be paid by mailed check.</p>
          <div class="row"><label>Payee name<input name="remitName" value="${esc(b.biller)}"></label><label>Street or PO box<input name="remitLine1"></label></div>
          <div class="row3"><label>City<input name="remitCity"></label><label>State<input name="remitState" maxlength="2"></label><label>ZIP<input name="remitZip" maxlength="10"></label></div>
        </fieldset>`}
        <label>Note to member <small>(required to reject)</small><input name="note" maxlength="500"></label>
        <p class="error" hidden></p>
        <div class="actions">
          <button class="btn btn-danger" data-decision="ban">Reject &amp; ban</button>
          <button class="btn btn-ghost" data-decision="reject">Reject</button>
          <button class="btn btn-primary" data-decision="approve">Approve</button>
        </div>
      </article>`).join("") : `<p class="empty">All caught up. Nothing awaits review.</p>`}</div>
    ${payoutsSection(payouts)}`;
}

const remitText = (r) => `${r.name}, ${r.line1}, ${r.city}, ${r.state} ${r.zip}`;
const LANE_SHORT = { debt_api: "Debt API", billpay_network: "Bill-pay network", virtual_card: "Virtual card", check: "Check" };

function payoutActions(p) {
  const err = `<p class="error" hidden></p>`;
  switch (p.status) {
    case "needs_agent":
      return `<div class="agent-task">
        <p><strong>Pay on ${esc(p.biller)}'s official guest-pay page</strong> — find it yourself on their website, never from a link in the statement.
        Account <code>…${esc(p.accountLast4)}</code> · amount <strong>${money(p.amountCents)}</strong>.</p>
        ${p.card ? `<p class="vcard">Single-use card •••• ${esc(p.card.last4)} · exp ${esc(p.card.expires)} · limit ${money(p.card.limitCents)} <small>(full number revealed in the card provider's dashboard)</small></p>` : ""}
        <div class="payout-mark"><input name="confirmation" placeholder="Confirmation no. from the biller" maxlength="80">
          <button class="btn btn-primary" data-payout-action="agent-paid">Paid</button>
          <button class="btn btn-danger" data-payout-action="fail">Couldn't pay</button></div>${err}</div>`;
    case "sent":
      return p.autoConfirm ? `<span class="muted-line">Waiting for ${esc(p.provider)} to confirm</span>`
        : `<div class="payout-mark"><input name="note" placeholder="e.g. Check cleared 11/14" maxlength="120">
            <button class="btn btn-ghost" data-payout-action="confirm">Confirm</button>
            <button class="btn btn-danger" data-payout-action="fail">Failed</button></div>${err}`;
    case "held":
      return `<span class="muted-line">Releases ${new Date(p.releaseAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        <div class="payout-mark"><button class="btn btn-ghost" data-payout-action="release">Release now</button>
        <button class="btn btn-danger" data-payout-action="refund">Refund patron</button></div>${err}`;
    case "failed":
      return `<div class="payout-mark">
        ${p.remit ? "" : `<input name="remitLine1" placeholder="Verified street / PO box"><input name="remitCity" placeholder="City" class="w-city"><input name="remitState" placeholder="ST" maxlength="2" class="w-st"><input name="remitZip" placeholder="ZIP" maxlength="10" class="w-zip">`}
        <button class="btn btn-ghost" data-payout-action="retry-check">Retry by check</button>
        <button class="btn btn-danger" data-payout-action="refund">Refund patron</button></div>${err}`;
    case "confirmed":
      return `<span class="muted-line">${esc(p.proof?.detail || "Confirmed")}</span>`;
    default:
      return `<span class="muted-line">${esc(p.events.at(-1)?.note || "")}</span>`;
  }
}

function payoutsSection(payouts) {
  const action = payouts.filter((p) => p.needsAction);
  const count = (st) => payouts.filter((p) => p.status === st).length;
  const owed = payouts.filter((p) => ["held", "sent", "needs_agent", "failed"].includes(p.status)).reduce((s, p) => s + p.amountCents, 0);
  return `
    <section class="card payouts">
      <div class="tax-head">
        <div><span class="eyebrow">Money owed to billers</span><h2>Payouts ${action.length ? `<span class="count">${action.length} need you</span>` : ""}</h2></div>
        <button class="btn btn-ghost" data-action="process-payouts">Process now</button>
      </div>
      <div class="lane-legend">
        <span><strong>Debt API</strong> credit cards, loans</span><span><strong>Bill-pay network</strong> utilities, telecom</span>
        <span><strong>Virtual card</strong> guest-pay portals</span><span><strong>Check</strong> everything else</span>
      </div>
      <p class="muted-line">${money(owed)} in flight · ${count("held")} on hold · ${count("sent")} sent · ${count("confirmed")} confirmed · ${count("failed")} failed</p>
      ${payouts.length ? `<table class="tax-table payout-table">
        <thead><tr><th>Biller</th><th>Lane</th><th>For</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${payouts.map((p) => `<tr data-payout="${esc(p.id)}" class="${p.needsAction ? "needs" : ""}">
          <td>${esc(p.biller)}<br><small class="muted-line">…${esc(p.accountLast4)}${p.reference ? " · " + esc(p.reference) : ""}</small></td>
          <td>${esc(LANE_SHORT[p.lane] || p.lane)}<br><small class="muted-line">${esc(p.provider)}</small></td>
          <td>${esc(p.billTitle)}</td><td>${money(p.amountCents)}</td>
          <td><span class="po po-${esc(p.status)}">${esc(p.status.replace("_", " "))}</span></td>
          <td>${payoutActions(p)}</td></tr>`).join("")}</tbody>
      </table>` : `<p class="empty-small">No payouts yet.</p>`}
    </section>`;
}

// ---------- routing ----------

async function route() {
  const r = location.hash.replace(/^#/, "") || "/";
  const views = { "/": "view-feed", "/deck": "view-deck", "/ledger": "view-ledger", "/review": "view-review" };
  const doc = r.match(/^\/(receipt|statement)\/([\w-]+)$/);
  let view = doc ? "view-doc" : views[r] || "view-feed";
  if ((view === "view-ledger" || view === "view-review" || view === "view-doc") && !state.me) view = "view-feed";
  if (view === "view-doc" && !isRole("patron")) view = "view-feed";
  if (view === "view-deck" && state.me && !isRole("patron")) view = "view-feed";
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  window.scrollTo(0, 0);
  try {
    if (view === "view-feed") await refreshFeed();
    if (view === "view-deck") await loadDeck();
    if (view === "view-doc") await (doc[1] === "receipt" ? renderReceipt(doc[2]) : renderStatement(Number(doc[2])));
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
  const t = e.target.closest("[data-auth],[data-action],[data-close],[data-pay],[data-report],[data-decision],[data-swipe],[data-payout-action]");
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
  if (t.dataset.action === "print") return window.print();
  if (t.dataset.action === "change-biller") { resetBillerPicker(); return billerSearch.focus(); }
  if (t.dataset.action === "process-payouts") {
    await api("/admin/payouts/process", { method: "POST", body: {} }).catch(() => {});
    return renderReview($("#view-review"));
  }
  if (t.dataset.payoutAction) {
    const row = t.closest("[data-payout]");
    const act = t.dataset.payoutAction;
    const val = (n) => $(`input[name=${n}]`, row)?.value || "";
    const body = { confirmation: val("confirmation"), note: val("note") };
    if (act === "fail") body.reason = prompt("What went wrong?") || "";
    if (act === "refund" && !confirm("Refund this patron? The bill reopens for this amount.")) return;
    if (act === "retry-check" && val("remitLine1")) {
      const name = row.querySelector("td").firstChild.textContent.trim();
      body.remit = { name, line1: val("remitLine1"), city: val("remitCity"), state: val("remitState"), zip: val("remitZip") };
    }
    try {
      await api(`/admin/payouts/${row.dataset.payout}/${act}`, { method: "POST", body });
      toast({ "agent-paid": "Recorded. Biller payment confirmed.", confirm: "Payment confirmed.", fail: "Marked as failed.", "retry-check": "Check sent.", refund: "Patron refunded.", release: "Released and sent." }[act]);
      return renderReview($("#view-review"));
    } catch (err) { return showError(row, err.message); }
  }
  if (t.dataset.action === "confirm-received") {
    try {
      await api(`/my/bills/${t.dataset.bill}/confirm-received`, { method: "POST", body: {} });
      toast("Thank you — marked as received.");
      return route();
    } catch (err) { return toast(err.message); }
  }
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

// ---------- biller picker ----------

const billerSearch = $("#biller-search");
const billerResults = $("#biller-results");
let billerTimer = null, billerItems = [], billerActive = -1;

function chooseBiller(b) {
  postForm.billerId.value = b ? b.id : "other";
  billerResults.hidden = true;
  billerSearch.setAttribute("aria-expanded", "false");
  $("#biller-name-wrap").hidden = Boolean(b);
  billerSearch.closest("label").hidden = true;
  $("#biller-chosen").hidden = false;
  $("#biller-chosen").innerHTML = b
    ? `<div><strong>${esc(b.name)}</strong><span class="muted-line">${esc(b.laneName)} — ${esc(b.how)}</span></div><button type="button" class="btn btn-link" data-action="change-biller">Change</button>`
    : `<div><strong>Not listed</strong><span class="muted-line">A reviewer will verify a payment address before your bill goes live.</span></div><button type="button" class="btn btn-link" data-action="change-biller">Change</button>`;
  if (b) {
    postForm.billerName.value = "";
    postForm.category.value = b.category;
    postForm.accountNumber.placeholder = b.accountHint;
    $("#account-hint").textContent = `(${b.accountHint}, exactly as on your statement — encrypted, never shown to patrons)`;
  } else {
    postForm.billerName.value = billerSearch.value;
    postForm.accountNumber.placeholder = "Account number";
    $("#account-hint").textContent = "(exactly as on your statement — encrypted, never shown to patrons)";
    postForm.billerName.focus();
  }
}

function resetBillerPicker() {
  postForm.billerId.value = "";
  billerSearch.value = "";
  billerSearch.closest("label").hidden = false;
  $("#biller-chosen").hidden = true;
  $("#biller-name-wrap").hidden = true;
  billerResults.hidden = true;
  $("#account-hint").textContent = "(exactly as on your statement — encrypted, never shown to patrons)";
}

function renderBillerResults() {
  billerResults.innerHTML = billerItems.map((b, i) => `<li role="option" data-i="${i}" class="${i === billerActive ? "active" : ""}">
      <strong>${esc(b.name)}</strong><span>${esc(label(b.category))} · ${esc(b.laneName)}</span></li>`).join("")
    + `<li role="option" data-i="other" class="${billerActive === billerItems.length ? "active" : ""}"><strong>Not listed — enter it myself</strong><span>A reviewer verifies how to pay them</span></li>`;
  billerResults.hidden = false;
  billerSearch.setAttribute("aria-expanded", "true");
}

billerSearch.addEventListener("input", () => {
  clearTimeout(billerTimer);
  billerTimer = setTimeout(async () => {
    billerItems = await api("/billers?q=" + encodeURIComponent(billerSearch.value)).catch(() => []);
    billerActive = billerItems.length ? 0 : -1;
    renderBillerResults();
  }, 120);
});
billerSearch.addEventListener("focus", () => billerSearch.dispatchEvent(new Event("input")));
billerSearch.addEventListener("keydown", (e) => {
  if (billerResults.hidden) return;
  const max = billerItems.length; // last index = "Not listed"
  if (e.key === "ArrowDown") { billerActive = Math.min(max, billerActive + 1); renderBillerResults(); e.preventDefault(); }
  if (e.key === "ArrowUp") { billerActive = Math.max(0, billerActive - 1); renderBillerResults(); e.preventDefault(); }
  if (e.key === "Enter") { e.preventDefault(); chooseBiller(billerActive < max ? billerItems[billerActive] : null); }
  if (e.key === "Escape") billerResults.hidden = true;
});
billerResults.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  chooseBiller(li.dataset.i === "other" ? null : billerItems[Number(li.dataset.i)]);
});
billerSearch.addEventListener("blur", () => setTimeout(() => (billerResults.hidden = true), 150));

function openPost() {
  if (!state.me) return openAuth("join", "member");
  if (!isRole("member")) return;
  if (state.me.canSubmit === false) return toast(state.me.cantSubmitReason);
  postForm.reset();
  resetBillerPicker();
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
  if (!f.billerId.value) return showError(f, "Choose who the bill is owed to");
  if (!file) return showError(f, "Please attach your statement or invoice");
  if (file.size > 4 * 1024 * 1024) return showError(f, "Statement must be 4 MB or smaller");
  if (!f.attest.checked) return showError(f, "Please confirm the bill is real and yours");
  const submit = $("button[type=submit]", f);
  submit.disabled = true;
  try {
    const body = {
      title: f.title.value, story: f.story.value, amount: f.amount.value, category: f.category.value,
      billerId: f.billerId.value || "other", billerName: f.billerName.value, accountNumber: f.accountNumber.value, city: f.city.value, dueDate: f.dueDate.value,
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
  resetCardStep();
  updateFee();
  $("#pay-tax").hidden = true;
  state.taxPreview = null;
  api(`/bills/${bill.id}/tax-preview`).then((t) => { state.taxPreview = t; updateTaxNote(); }).catch(() => {});
  $("#pay-dialog").showModal();
}

payForm.payInFull.addEventListener("change", () => {
  const bill = findBill(payingId);
  payForm.amount.disabled = payForm.payInFull.checked;
  if (payForm.payInFull.checked && bill) payForm.amount.value = (bill.remainingCents / 100).toFixed(2);
});

// ---------- payments: simulated, or Stripe test mode ----------

const isStripe = () => state.config?.payments?.mode === "stripe";
const pay = { stripe: null, elements: null, intent: null, busy: false };

function feeFor(amountCents) {
  const f = state.config?.cardFee || { percent: 0.029, fixedCents: 30 };
  return Math.ceil((amountCents + f.fixedCents) / (1 - f.percent)) - amountCents;
}

function updateFee() {
  const el = $("#pay-fee");
  if (!isStripe()) { el.hidden = true; $("#pay-submit").textContent = "Settle"; return; }
  const amt = Math.round(Number(payForm.amount.value || 0) * 100) || 0;
  const fee = amt ? feeFor(amt) : 0;
  el.innerHTML = amt ? `Card total <strong>${money(amt + fee)}</strong> — includes ${money(fee)} card processing, so ${esc(findBill(payingId)?.biller || "the biller")} receives the full ${money(amt)}.` : "";
  el.hidden = !amt;
  if (!pay.intent) $("#pay-submit").textContent = "Continue to payment";
}
payForm.amount.addEventListener("input", updateFee);
payForm.payInFull.addEventListener("change", updateFee);

function resetCardStep() {
  pay.intent = null; pay.elements = null;
  $("#card-step").hidden = true;
  $("#payment-element").innerHTML = "";
  for (const el of [payForm.amount, payForm.payInFull, payForm.anonymous, payForm.message]) el.disabled = false;
  if (payForm.payInFull.checked) payForm.amount.disabled = true;
}

let stripeJs = null;
function loadStripe() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  // Stripe.js must be loaded from js.stripe.com (PCI requirement); it is never bundled or self-hosted.
  stripeJs ||= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://js.stripe.com/v3/";
    tag.onload = () => resolve(window.Stripe);
    tag.onerror = () => { stripeJs = null; reject(new Error("Couldn't load the card form. Check your connection.")); };
    document.head.appendChild(tag);
  });
  return stripeJs;
}

// Step 1 (Stripe): create the PaymentIntent for the chosen amount and show the card form.
async function startCardStep(body) {
  const StripeCtor = await loadStripe();
  pay.stripe ||= StripeCtor(state.config.payments.publishableKey);
  const intent = await api(`/bills/${payingId}/payment-intent`, { method: "POST", body });
  pay.intent = intent;
  pay.elements = pay.stripe.elements({
    clientSecret: intent.clientSecret,
    appearance: {
      theme: "night",
      variables: { colorPrimary: "#c9a961", colorBackground: "#1b1813", colorText: "#f1ead8", colorDanger: "#e07a6a", borderRadius: "4px", fontFamily: "Inter, system-ui, sans-serif" },
    },
    fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap" }],
  });
  pay.elements.create("payment", { layout: "tabs" }).mount("#payment-element");
  for (const el of [payForm.amount, payForm.payInFull, payForm.anonymous, payForm.message]) el.disabled = true;
  $("#card-step").hidden = false;
  $("#test-hint").hidden = !/^pk_test_/.test(state.config.payments.publishableKey);
  $("#pay-submit").textContent = `Pay ${money(intent.chargeCents)}`;
}

// Step 2 (Stripe): confirm in the browser, then have the server verify with Stripe and record it.
async function finishCardStep() {
  const { error } = await pay.stripe.confirmPayment({
    elements: pay.elements,
    redirect: "if_required",
    confirmParams: { return_url: location.origin + "/#/ledger" },
  });
  if (error) throw new Error(error.message || "Your card was declined.");
  for (let i = 0; i < 5; i++) { // the webhook may still be catching up; retry briefly
    try { return await api(`/payments/${pay.intent.paymentIntentId}/confirm`, { method: "POST", body: {} }); }
    catch (err) { if (i === 4 || !/hasn't completed/.test(err.message)) throw err; await new Promise((r) => setTimeout(r, 800)); }
  }
}

function afterPaid(res, beforeTier) {
  $("#pay-dialog").close();
  if (res.refunded) {
    toast(`Another patron settled this first — your ${money(res.refundedCents)} has been refunded to your card.`);
  } else {
    state.me = { ...state.me, givenCents: res.givenCents, tier: res.tier };
    renderNav();
    const refundNote = res.refundedCents ? ` ${money(res.refundedCents)} was more than remained and has been refunded.` : "";
    if (res.tier.id !== beforeTier) toast(`You've risen to ${res.tier.name}. The Circle takes note.${refundNote}`);
    else toast(`${res.bill.paidOff ? "Account settled. Most generous." : "Received with gratitude."} Receipt ${res.receipt.receiptNo} filed to your tax documents.${refundNote}`);
  }
  if (deckPending === payingId) { deckPending = null; state.deck.shift(); renderDeck(); }
  else refreshFeed();
}

payForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (pay.busy) return;
  const before = state.me?.tier?.id;
  const body = { amount: payForm.amount.value, payInFull: payForm.payInFull.checked, anonymous: payForm.anonymous.checked, message: payForm.message.value };
  const submit = $("#pay-submit");
  pay.busy = true; submit.disabled = true; showError(payForm, "");
  try {
    if (!isStripe()) return afterPaid(await api(`/bills/${payingId}/pay`, { method: "POST", body }), before);
    if (!pay.intent) return await startCardStep(body);
    afterPaid(await finishCardStep(), before);
  } catch (err) { showError(payForm, err.message); }
  finally { pay.busy = false; submit.disabled = false; }
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

// ---------- paperwork: tax note, tax documents, receipts, statements ----------

const TREATMENT = {
  medical: "Medical bill paid directly to the provider — generally excluded from gift tax with no dollar limit (IRC §2503(e)), and not reported on Form 709.",
  gift: "Gift to an individual, paid to their creditor — counts toward the annual gift-tax exclusion for this recipient.",
};
const NOT_DEDUCTIBLE = "Not a tax-deductible charitable contribution: gifts that benefit a specific person can't be deducted.";

function updateTaxNote() {
  const t = state.taxPreview, el = $("#pay-tax");
  if (!t || payingId == null) return;
  const amt = Math.round(Number(payForm.amount.value || 0) * 100) || 0;
  let html = `<strong>Paperwork:</strong> ${TREATMENT[t.treatment]}`;
  if (t.treatment === "gift") {
    const after = t.givenToRecipientThisYearCents + amt;
    html += ` You've given this person ${money(t.givenToRecipientThisYearCents)} in ${t.year}; the exclusion is ${money(t.annualExclusionCents)}.`;
    if (after > t.annualExclusionCents) html += ` <span class="tax-warn">This gift takes you ${money(after - t.annualExclusionCents)} over — you'd file Form 709 (usually no tax owed).</span>`;
  }
  html += ` <span class="tax-fine">${NOT_DEDUCTIBLE} A receipt is filed automatically.</span>`;
  el.innerHTML = html;
  el.hidden = false;
}
payForm.amount.addEventListener("input", updateTaxNote);
payForm.payInFull.addEventListener("change", updateTaxNote);

function taxCard(t) {
  const years = t.years.length ? t.years : [t.year];
  if (!years.includes(t.year)) years.unshift(t.year);
  return `
    <section class="card tax-card">
      <div class="tax-head">
        <div><span class="eyebrow">Paperwork, handled</span><h2>Tax documents</h2></div>
        <select id="tax-year" aria-label="Tax year">${years.map((y) => `<option ${y === t.year ? "selected" : ""}>${y}</option>`).join("")}</select>
      </div>
      <div class="tax-figures">
        <div><span class="mc-label">Total given</span><strong>${money(t.totalCents)}</strong></div>
        <div><span class="mc-label">Medical, paid to providers</span><strong>${money(t.medicalCents)}</strong><span class="muted-line">Excluded from gift tax</span></div>
        <div><span class="mc-label">Gifts to individuals</span><strong>${money(t.giftCents)}</strong><span class="muted-line">${money(t.annualExclusionCents)} exclusion per person</span></div>
      </div>
      ${t.form709Likely ? `<p class="tax-warn-box">You gave more than ${money(t.annualExclusionCents)} in non-medical gifts to at least one person in ${t.year}. A gift tax return (Form 709) is likely due by April 15 — tax is rarely owed, as it draws on your lifetime exemption.</p>` : ""}
      ${t.recipients.length ? `<table class="tax-table">
        <thead><tr><th>On behalf of</th><th>Medical</th><th>Other gifts</th><th></th></tr></thead>
        <tbody>${t.recipients.map((r) => `<tr><td>${esc(r.recipient)}</td><td>${money(r.medicalCents)}</td><td>${money(r.giftCents)}</td>
          <td>${r.overExclusion ? `<span class="status status-flagged">Over by ${money(r.overByCents)}</span>` : `<span class="status status-verified">Within exclusion</span>`}</td></tr>`).join("")}</tbody>
      </table>` : `<p class="empty-small">No gifts in ${t.year}.</p>`}
      <div class="actions tax-actions">
        <a class="btn btn-ghost" href="/api/my/tax.csv?year=${t.year}" download>Download CSV for your accountant</a>
        <a class="btn btn-primary" href="#/statement/${t.year}">Annual statement</a>
      </div>
      <p class="tax-fine">${NOT_DEDUCTIBLE} BillDrop provides records, not tax advice — share these with your tax professional.</p>
    </section>`;
}

const docShell = (inner) => `
  <div class="doc-toolbar"><a class="btn btn-link" href="#/ledger">← Back</a><button class="btn btn-primary" data-action="print">Print or save as PDF</button></div>
  <article class="paper">${inner}
    <footer class="paper-foot">BillDrop · The Private Ledger · Records only, not tax advice. ${NOT_DEDUCTIBLE}</footer>
  </article>`;

async function renderReceipt(id) {
  const r = await api("/my/receipts/" + encodeURIComponent(id));
  $("#view-doc").innerHTML = docShell(`
    <div class="paper-head"><div><span class="paper-brand">BillDrop</span><span class="paper-kind">Payment receipt</span></div>
      <div class="paper-meta">No. ${esc(r.receiptNo)}<br>${new Date(r.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div></div>
    <dl class="paper-facts">
      <dt>Paid by</dt><dd>${esc(r.payer.name)} &lt;${esc(r.payer.email)}&gt;</dd>
      <dt>Paid directly to</dt><dd>${esc(r.payee)}</dd>
      <dt>On behalf of</dt><dd>${esc(r.onBehalfOf)}</dd>
      <dt>For</dt><dd>${esc(r.billTitle)} (${esc(label(r.category))})</dd>
      <dt>Amount</dt><dd class="paper-amt">${money(r.amountCents)}</dd>
      ${r.feeCents ? `<dt>Card processing</dt><dd>${money(r.feeCents)} — paid by you so the biller received the full amount; not part of the gift</dd>` : ""}
    </dl>
    ${r.payout ? `<p class="paper-note"><strong>Payment to biller:</strong> ${esc(r.payout.statusText)} · ${esc(r.payout.laneName)} (${esc(r.payout.provider)})${r.payout.reference ? ` · ref ${esc(r.payout.reference)}` : ""}${r.payout.confirmedAt ? ` · confirmed ${new Date(r.payout.confirmedAt).toLocaleDateString("en-US")}` : ""}</p>` : ""}
    <p class="paper-note"><strong>Gift-tax treatment:</strong> ${TREATMENT[r.treatment]}${r.treatment === "medical" ? " If insurance later reimburses this expense, the reimbursed portion does not qualify." : ""}</p>`);
}

async function renderStatement(year) {
  const t = await api("/my/tax?year=" + year);
  $("#view-doc").innerHTML = docShell(`
    <div class="paper-head"><div><span class="paper-brand">BillDrop</span><span class="paper-kind">Annual giving statement · ${t.year}</span></div>
      <div class="paper-meta">${esc(state.me.displayName)}<br>${esc(state.me.email)}</div></div>
    <div class="paper-summary">
      <div><span>Total paid</span><strong>${money(t.totalCents)}</strong></div>
      <div><span>Medical, direct to provider (IRC §2503(e))</span><strong>${money(t.medicalCents)}</strong></div>
      <div><span>Gifts to individuals (annual exclusion ${money(t.annualExclusionCents)}/person)</span><strong>${money(t.giftCents)}</strong></div>
    </div>
    ${t.form709Likely ? `<p class="paper-note"><strong>Form 709 likely required:</strong> non-medical gifts to at least one recipient exceeded ${money(t.annualExclusionCents)} in ${t.year}.</p>` : ""}
    <h3>By recipient</h3>
    <table class="paper-table"><thead><tr><th>On behalf of</th><th>Medical</th><th>Other gifts</th><th>Over exclusion</th></tr></thead>
      <tbody>${t.recipients.map((r) => `<tr><td>${esc(r.recipient)}</td><td>${money(r.medicalCents)}</td><td>${money(r.giftCents)}</td><td>${r.overExclusion ? money(r.overByCents) : "—"}</td></tr>`).join("") || `<tr><td colspan="4">No gifts this year.</td></tr>`}</tbody></table>
    <h3>All payments</h3>
    <table class="paper-table"><thead><tr><th>Receipt</th><th>Date</th><th>Paid to</th><th>On behalf of</th><th>Treatment</th><th>Amount</th></tr></thead>
      <tbody>${t.receipts.map((r) => `<tr><td>${esc(r.receiptNo)}</td><td>${r.date.slice(0, 10)}</td><td>${esc(r.payee)}</td><td>${esc(r.onBehalfOf)}</td><td>${r.treatment === "medical" ? "Medical §2503(e)" : "Gift"}</td><td>${money(r.amountCents)}</td></tr>`).join("") || `<tr><td colspan="6">—</td></tr>`}</tbody></table>`);
}

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
    const body = { decision, note: $("input[name=note]", item).value };
    const map = $("select[name=mapBiller]", item);
    if (decision === "approve" && map) {
      if (map.value) body.billerId = map.value;
      else if ($("input[name=remitLine1]", item).value) {
        body.remit = { name: $("input[name=remitName]", item).value, line1: $("input[name=remitLine1]", item).value,
          city: $("input[name=remitCity]", item).value, state: $("input[name=remitState]", item).value, zip: $("input[name=remitZip]", item).value };
      }
    }
    await api(`/admin/bills/${item.dataset.id}/review`, { method: "POST", body });
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
  const [cats, me, config] = await Promise.all([api("/categories"), api("/me").catch(() => null), api("/config")]);
  state.me = me;
  state.config = config;
  const opts = cats.map((c) => `<option value="${c}">${label(c)}</option>`).join("");
  $("#filter-category").insertAdjacentHTML("beforeend", opts);
  postForm.category.innerHTML = opts;
  renderNav();
  route();
})();
