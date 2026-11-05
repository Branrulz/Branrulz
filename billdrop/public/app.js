const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { status: "open", category: "", sort: "newest", bills: [] };

const money = (c) => "$" + (c / 100).toLocaleString(undefined, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const label = (cat) => cat.replace("-", " ").replace(/\b\w/g, (m) => m.toUpperCase());
const ICON = { medical: "🏥", rent: "🏠", "student-loan": "🎓", "credit-card": "💳", utilities: "💡", car: "🚗", other: "📄" };

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
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- rendering ----------

function billCard(b) {
  const pct = Math.min(100, Math.round((b.paidCents / b.amountCents) * 100));
  const latest = b.contributions.slice(-2).reverse();
  return `
    <article class="bill ${b.paidOff ? "paid" : ""}">
      <div class="bill-head">
        <span class="cat">${ICON[b.category] || "📄"} ${esc(label(b.category))}</span>
        ${b.paidOff ? `<span class="stamp">PAID OFF</span>` : due(b.dueDate)}
      </div>
      <h3>${esc(b.title)}</h3>
      <p class="who">${esc(b.name)}${b.city ? " · " + esc(b.city) : ""} · ${ago(b.createdAt)}</p>
      <p class="story">${esc(b.story)}</p>
      <p class="biller">Owed to <strong>${esc(b.biller)}</strong></p>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="amounts">
        <span><strong>${money(b.paidCents)}</strong> of ${money(b.amountCents)}</span>
        <span>${b.paidOff ? "🎉 Done" : money(b.remainingCents) + " left"}</span>
      </div>
      ${latest.length ? `<ul class="contribs">${latest.map((c) => `<li><strong>${esc(c.patron)}</strong> paid ${money(c.amountCents)}${c.message ? ` — “${esc(c.message)}”` : ""}</li>`).join("")}</ul>` : ""}
      ${b.paidOff ? "" : `<button class="btn btn-primary btn-block" data-pay="${esc(b.id)}">Pay this off</button>`}
    </article>`;
}

async function loadFeed() {
  const q = new URLSearchParams({ status: state.status, sort: state.sort });
  if (state.category) q.set("category", state.category);
  try {
    state.bills = await api("/bills?" + q);
    $("#feed").innerHTML = state.bills.length
      ? state.bills.map(billCard).join("")
      : `<p class="empty">Nothing here yet. ${state.status === "paid" ? "Billionaires, get to work." : "Post the first bill!"}</p>`;
  } catch (e) {
    $("#feed").innerHTML = `<p class="empty">Couldn't load bills: ${esc(e.message)}</p>`;
  }
}

async function loadStats() {
  const s = await api("/stats");
  $("#stat-paid").textContent = money(s.totalPaidCents);
  $("#stat-count").textContent = s.billsPaidOff;
  $("#stat-need").textContent = money(s.openNeedCents);
  $("#leaderboard").innerHTML = s.leaderboard.length
    ? s.leaderboard.map((p) => `<li><span>${esc(p.patron)}</span><strong>${money(p.amountCents)}</strong></li>`).join("")
    : `<li class="empty-small">No patrons yet. Be the first.</li>`;
}

const refresh = () => Promise.all([loadFeed(), loadStats()]);

// ---------- dialogs ----------

function showError(form, msg) {
  const el = $(".error", form);
  el.textContent = msg;
  el.hidden = !msg;
}

$$("[data-open]").forEach((b) => b.addEventListener("click", () => $("#" + b.dataset.open).showModal()));
$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

$("#post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  try {
    await api("/bills", { method: "POST", body });
    form.reset();
    showError(form, "");
    form.closest("dialog").close();
    toast("Bill posted. Fingers crossed a billionaire is bored today.");
    state.status = "open";
    state.sort = "newest";
    $("#filter-sort").value = "newest";
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.status === "open"));
    refresh();
  } catch (err) { showError(form, err.message); }
});

let payingId = null;
const payForm = $("#pay-form");

$("#feed").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pay]");
  if (!btn) return;
  const bill = state.bills.find((b) => b.id === btn.dataset.pay);
  if (!bill) return;
  payingId = bill.id;
  payForm.reset();
  showError(payForm, "");
  $("#pay-title").textContent = `“${bill.title}”`;
  $("#pay-remaining").textContent = `${money(bill.remainingCents)} left, owed to ${bill.biller}.`;
  payForm.amount.max = (bill.remainingCents / 100).toFixed(2);
  payForm.amount.value = (bill.remainingCents / 100).toFixed(2);
  payForm.amount.disabled = false;
  $("#pay-dialog").showModal();
});

payForm.payInFull.addEventListener("change", () => {
  const bill = state.bills.find((b) => b.id === payingId);
  payForm.amount.disabled = payForm.payInFull.checked;
  if (payForm.payInFull.checked && bill) payForm.amount.value = (bill.remainingCents / 100).toFixed(2);
});

payForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    amount: payForm.amount.value,
    payInFull: payForm.payInFull.checked,
    patron: payForm.patron.value,
    message: payForm.message.value,
  };
  try {
    const bill = await api(`/bills/${payingId}/pay`, { method: "POST", body });
    payForm.closest("dialog").close();
    toast(bill.paidOff ? `🎉 “${bill.title}” is PAID OFF!` : `Thanks! ${money(bill.remainingCents)} to go.`);
    refresh();
  } catch (err) { showError(payForm, err.message); }
});

// ---------- filters ----------

$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  state.status = tab.dataset.status;
  loadFeed();
}));
$("#filter-category").addEventListener("change", (e) => { state.category = e.target.value; loadFeed(); });
$("#filter-sort").addEventListener("change", (e) => { state.sort = e.target.value; loadFeed(); });

// ---------- boot ----------

(async () => {
  const cats = await api("/categories");
  const opts = cats.map((c) => `<option value="${c}">${ICON[c] || ""} ${label(c)}</option>`).join("");
  $("#filter-category").insertAdjacentHTML("beforeend", opts);
  $("#post-form").category.innerHTML = opts;
  refresh();
})();
