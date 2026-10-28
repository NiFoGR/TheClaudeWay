// Setup page, top to bottom: the health lights, the connections (Database, GitHub), mailboxes (Test login and
// Send test email, the SMTP proof), the email DNS records, receiving replies (D-1), Claude's access key and Routines,
// the business details (D-7) and Payments (Stripe: Connect Stripe). Every value from the server (addresses, names,
// errors, DNS records, Stripe's messages) goes through esc() before it touches the page; secrets are never sent here,
// only "saved ✓".
// The renderers (…Html, sendOutcome, loginText) are pure and exported, so tests/shell.test.mjs checks them without a
// browser. The DOM work happens inside setupPage() and the handlers it binds.
import { api, esc, fmtDate, icon, modal, pageHead, safeUrl, toast, view } from "./lib.js";

const REPO = "https://github.com/NiFoGR/TheClaudeWay/blob/claude/confident-hawking-vi0lgk";
const LEVELS = ["green", "amber", "red", "grey"];
const HOW = "how ↓";

export const NO_MAILBOX = "No mailbox yet. Buy one Namecheap Private Email mailbox on aetoswebsites.com (Launch plan, not the trial), then add it here. Cold emails start 14 days after the date you bought it, to warm it up.";
export const D2_1102 = "Cloudflare stopped this send because it used more computer time than the free plan allows (Error 1102). That's decision D-2: the $5/month Workers Paid plan fixes it. It may or may not have been sent: check the inbox.";
export const TOKEN_ONCE = "Copy it now: it won't be shown again. Paste it into the Claude environment as a network secret (routines/README.md, section 1). Replacing it stops every Routine until you paste the new one.";
const sentText = (s) => `Sent in ${s} s. Check that inbox (and its spam folder). Then read the CPU time in Cloudflare: ${HOW}`;

// ---------------------------------------------------------------- small helpers (pure)

const secs = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// UK today as "YYYY-MM-DD", built from its parts: a locale's date pattern (e.g. en-CA's) isn't the same in every browser.
const UK_PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
function ukDateOf(date) {
  const p = Object.fromEntries(UK_PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const ukDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
const agoOr = (iso, now, fallback = "earlier") => since(iso, now) || fallback;

/** "just now", "3 min ago", "5 h ago", "2 days ago" (rounded down, like the health lights), or null for no time. */
export function since(iso, now = new Date()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const min = Math.floor(Math.max(0, now.getTime() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${plural(Math.floor(h / 24), "day")} ago`;
}

// "YYYY-MM-DD" + n days, or null when it isn't a date.
function addDays(day, n) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day)) && Number.isFinite(ms) ? new Date(ms + n * 86400000).toISOString().slice(0, 10) : null;
}

const section = (id, title, body, aside = "") => `<section class="setup-section" id="setup-${esc(id)}">
  <div class="section-title"><h2>${esc(title)}</h2>${aside}</div>${body}</section>`;

// A message under a row or form: plain text, with "how ↓" turned into a link to the CPU how-to.
function note(n) {
  if (!n?.text) return "";
  const cls = n.pending ? "muted" : n.ok ? "ok-text" : "bad-text";
  const how = n.how && n.text.endsWith(HOW);
  const text = how ? n.text.slice(0, -HOW.length) : n.text;
  const link = n.link ? ` <a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">Open the session</a>` : "";
  return `<span class="${cls}">${esc(text)}</span>${how ? `<a href="#/setup?at=cpu-how" data-scroll="cpu-how">${HOW}</a>` : ""}${link}`;
}

// ---------------------------------------------------------------- 1. Health

function lightRow(l) {
  const level = LEVELS.includes(l?.level) ? l.level : "grey";
  const fix = (level === "amber" || level === "red") && l.fix ? `<div class="fix">${esc(l.fix)}</div>` : "";
  return `<div class="light ${level}" title="${esc(l?.name)}"><span class="light-dot" role="img" aria-label="${level}"></span>
    <div><div class="detail">${esc(l?.detail)}</div>${fix}</div></div>`;
}

/** {lights, gaps} from /api/health (or {error}): one row per light, the fix under it when it's amber or red. */
export function healthHtml(health) {
  if (!health || health.error) {
    return section("health", "Health", `<div class="card"><p class="error" style="margin:0">${esc(`Couldn't check the system lights: ${health?.error || "no answer"}`)}</p></div>`);
  }
  const lights = Array.isArray(health.lights) ? health.lights : [];
  const gaps = Array.isArray(health.gaps) ? health.gaps : [];
  const todo = gaps.length ? `<details class="card gaps"><summary>Still to set up: ${esc(plural(gaps.length, "thing"))}</summary>
      <ul class="gap-list">${gaps.map((g) => `<li><b>${esc(g.title)}</b><div class="muted small">${esc(g.detail)}</div></li>`).join("")}</ul></details>` : "";
  const list = lights.length ? lights.map(lightRow).join("") : `<p class="muted" style="margin:0">No lights yet.</p>`;
  return section("health", "Health", `<div class="card light-list">${list}</div>${todo}`);
}

// ---------------------------------------------------------------- 2. Connections (the checks)

function connectionsHtml(checks, noteText) {
  return section("connections", "Connections", `
    <div class="card checks">${(checks || []).map((c) => `
      <div class="check"><span class="dot ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✕"}</span>
        <div><b>${esc(c.name)}</b><div class="muted small">${esc(c.ok ? c.detail : c.fix)}</div></div></div>`).join("")}
    </div>
    <p class="hint">${esc(noteText)} Full step-by-step guide: <code>control-room/README.md</code> in the repo.</p>`);
}

// ---------------------------------------------------------------- 3. Mailboxes

function todayCell(m, now) {
  if (m.role !== "cold") return `<span class="muted">no cap (system mail)</span>`;
  const sent = `${Number(m.sent_today) || 0} of ${Number(m.cap_today) || 0} sent`;
  const warmFrom = addDays(m.started_on, 14);
  const warming = m.status !== "paused" && (m.cap_override === null || m.cap_override === undefined || m.cap_override === "")
    && warmFrom && warmFrom > ukDateOf(now);
  return `${sent}${warming ? `<div class="sub-line">warming up: cold emails from ${esc(fmtDate(warmFrom))}</div>` : ""}`;
}

function mailboxRow(m, now, notes) {
  const id = esc(m.id);
  const paused = m.status === "paused";
  const status = paused
    ? `<span class="badge bad">Paused</span>${m.paused_reason ? `<div class="sub-line">${esc(m.paused_reason)}</div>` : ""}`
    : `<span class="badge good">Active</span>`;
  // The row's buttons, and the answer to the last one pressed, sit on their own line under it.
  return `<tr class="mb-row">
      <td><div class="biz">${esc(m.address)}</div></td>
      <td>${esc(m.display_name)}</td>
      <td>${m.role === "system" ? "System" : m.role === "cold" ? "Cold" : esc(m.role)}</td>
      <td class="num" style="white-space:nowrap">${/^\d{4}-\d{2}-\d{2}$/.test(String(m.started_on)) ? esc(fmtDate(m.started_on, true)) : esc(m.started_on)}</td>
      <td class="num mb-today">${todayCell(m, now)}</td>
      <td>${status}</td>
      <td>${m.has_password ? `<span class="ok-text">saved ✓</span>` : `<span class="bad-text">missing</span>`}</td>
    </tr>
    <tr class="mb-buttons"><td colspan="7"><div class="mb-actions"><button class="btn secondary sm" data-mb-login="${id}">Test login</button><button class="btn secondary sm" data-mb-send="${id}">Send test email</button><button class="btn ghost sm" data-mb-status="${id}" data-to="${paused ? "active" : "paused"}">${paused ? "Resume" : "Pause"}</button><button class="btn ghost sm" data-mb-edit="${id}">Edit</button>
      <span class="mb-note" data-mb-result="${id}">${note(notes[`mb:${m.id}`])}</span></div></td></tr>`;
}

function proofLine(status, now) {
  const p = status.smtp_proof;
  if (!p || typeof p !== "object") return "";
  const from = (status.mailboxes || []).find((m) => m.id === p.mailbox_id)?.address;
  const when = agoOr(p.at, now);
  const text = p.ok
    ? `Last test email: sent in ${secs(p.ms)} s, ${when}${from ? `, from ${from}` : ""}.`
    : `Last test email failed ${when}${from ? ` (from ${from})` : ""}: ${p.error || "no reason given"}`;
  return `<p class="hint"><span class="${p.ok ? "ok-text" : "bad-text"}">${esc(text)}</span></p>`;
}

// Part A, "How to read CPU time for the SMTP proof". Open until the first test email has been sent.
function cpuHow(open) {
  return `<details class="card how" id="setup-cpu-how" ${open ? "open" : ""}><summary>How to read CPU time for the SMTP proof</summary>
    <ol class="steps">
      <li>Cloudflare → Workers &amp; Pages → your Control Room project → Deployments → the latest (Production) → Functions → Real-time logs → Begin log stream.</li>
      <li>Press Send test email here. One log line appears for <code>/api/setup/mailboxes/…/test</code>.
        <ul><li>Outcome <code>ok</code>: it fitted.</li><li><code>exceededCpu</code> or <code>exceededResources</code>: it didn't.</li></ul></li>
      <li>Also open the project's Metrics (or Functions) tab → CPU time. Read the highest value for the minute you pressed the button. Under 10 ms means the free plan is enough.</li>
      <li>Do this 10 times. Ten "Sent" results, no <code>exceeded…</code> outcomes and all 10 in the inbox means stay on Free (D-2 closed). Any 1102 or <code>exceededCpu</code> means D-2: the Workers Paid plan at $5/month. Nothing else in the design changes.</li>
    </ol></details>`;
}

function addMailboxForm(status, now) {
  const today = ukDateOf(now);
  return `<form class="card setup-form" id="mb-add" autocomplete="off">
    <div class="card-head" style="margin:0"><h2>Add a mailbox</h2></div>
    <div class="field-row">
      <div><label for="mb-address">Address</label><input id="mb-address" type="email" required maxlength="254" placeholder="nik@aetoswebsites.com"></div>
      <div><label for="mb-name">Name shown in emails</label><input id="mb-name" required maxlength="100" value="${esc(status.business?.sender_name)}" placeholder="Nik"></div>
    </div>
    <div class="field-row">
      <div><label for="mb-role">Role</label><select id="mb-role"><option value="cold">Cold (first emails and follow-ups)</option><option value="system">System (client and onboarding mail)</option></select></div>
      <div><label for="mb-started">The date you bought it</label><input id="mb-started" type="date" required value="${esc(today)}" max="${esc(today)}"></div>
      <div><label for="mb-password">Password</label><input id="mb-password" type="password" autocomplete="new-password" placeholder="From Namecheap → Private Email"></div>
    </div>
    <p class="hint" style="margin:0">The password is write-only: once saved it's never shown again, only "saved ✓".</p>
    <p class="error" hidden></p>
    <div><button class="btn" type="submit">Add mailbox</button></div></form>`;
}

/** The mailbox table (or its empty state), the last test email, the CPU how-to and the Add a mailbox form. */
export function mailboxesHtml(status, now = new Date(), notes = {}) {
  const boxes = Array.isArray(status?.mailboxes) ? status.mailboxes : [];
  const table = boxes.length
    ? `<div class="table-card"><div class="table-wrap"><table class="mailbox-table"><thead><tr><th>Address</th><th>Name shown</th><th>Role</th><th>Started</th><th>Today</th><th>Status</th><th>Password</th></tr></thead>
        <tbody>${boxes.map((m) => mailboxRow(m, now, notes)).join("")}</tbody></table></div></div>`
    : `<div class="card"><p class="muted" style="margin:0">${esc(NO_MAILBOX)}</p></div>`;
  const aside = boxes.length ? `<span class="muted small">${esc(plural(boxes.length, "mailbox", "mailboxes"))}</span>` : "";
  return section("mailboxes", "Mailboxes", `${table}${proofLine(status || {}, now)}${cpuHow(!status?.smtp_proof)}${addMailboxForm(status || {}, now)}`, aside);
}

/** What Send test email's answer means. The body is read as text: Error 1102 comes back as Cloudflare's own page. */
export function sendOutcome(httpStatus, text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  // A JSON answer is the Control Room's own: never read as Cloudflare's 1102 page (its ms could be 1102).
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.ok === true) return { ok: true, message: sentText(secs(data.ms)) };
    if (typeof data.error === "string" && data.error) return { ok: false, message: data.error };
    return { ok: false, message: "The send didn't work and no reason came back. It may or may not have been sent: check the inbox, then press Send test email again." };
  }
  if (/\b1102\b/.test(String(text ?? ""))) return { ok: false, d2: true, message: D2_1102 };
  return { ok: false, message: `The Control Room answered HTTP ${httpStatus} instead of a result. It may or may not have been sent: check the inbox, then press Send test email again.` };
}

/** What Test login's answer {ok, ms, error?} means. */
export function loginText(result, mailbox) {
  if (result?.ok) return `Logged in to ${mailbox?.smtp_host || "mail.privateemail.com"} in ${secs(result.ms)} s.`;
  return result?.error || "The login test didn't give an answer. Wait a minute and try again.";
}

// ---------------------------------------------------------------- 4. DNS for <domain>

function dnsRow(c) {
  const ok = c?.ok === true;
  const rec = c?.record && typeof c.record === "object" ? c.record : {};
  const found = c?.found ? `<pre class="dns-found">${esc(c.found)}</pre>` : `<div class="sub-line">No ${esc(c?.name)} record found.</div>`;
  // DKIM's "content" says where to find the value at Namecheap: it's not a value to copy.
  const literal = c?.name !== "DKIM";
  const content = literal ? `<code>${esc(rec.content)}</code>` : esc(rec.content);
  const copy = literal ? `<button type="button" class="btn secondary sm" data-copy-text="${esc(rec.content)}">Copy</button>` : "";
  const fix = ok ? "" : `<div class="dns-fix"><div>${esc(c?.fix)}</div>
      <div class="record"><span><span class="faint">Type</span> <code>${esc(rec.type)}</code></span><span><span class="faint">Name</span> <code>${esc(rec.name)}</code></span>
        <span class="grow"><span class="faint">Content</span> ${content}</span>${copy}</div></div>`;
  return `<div class="check"><span class="dot ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"}</span><div><b>${esc(c?.name)}</b>${found}${fix}</div></div>`;
}

/** One domain's SPF, DKIM and DMARC rows (✓ or ✕, with the record to add for each ✕), its MX line and Check again. */
export function dnsHtml(domain, dns, now = new Date(), notes = {}) {
  const d = dns && typeof dns === "object" ? dns : {};
  const checks = Array.isArray(d.checks) ? d.checks : [];
  const rows = checks.length ? checks.map(dnsRow).join("") : `<p class="muted" style="margin:0">Not checked yet: press Check again.</p>`;
  const mx = d.mx_note ? `<div class="dns-mx"><span class="badge plain">MX</span> ${esc(d.mx_note)}</div>` : "";
  const when = d.at ? `checked ${agoOr(d.at, now)}` : "never checked";
  const n = notes[`dns:${domain}`];
  return section(`dns-${domain}`, `DNS for ${domain}`, `<div class="card">
      <p class="muted" style="margin-top:0">Each ✕ shows the record to add in Cloudflare → ${esc(domain)} → DNS → Add record. Edit an existing SPF record; never add a second one.</p>
      <div class="checks">${rows}</div>${mx}
      <div class="actions" style="margin-top:14px;align-items:center"><button class="btn secondary sm" data-dns="${esc(domain)}">Check again</button>${n ? note(n) : ""}</div></div>`,
  `<span class="muted small">${esc(when)}</span>`);
}

function dnsSections(status, now, notes) {
  const domains = Object.keys(status?.dns || {});
  if (!domains.length) {
    return section("dns", "DNS", `<div class="card"><p class="muted" style="margin:0">Add a mailbox first: its domain's email records (SPF, DKIM and DMARC) are checked here.</p></div>`);
  }
  return domains.map((domain) => dnsHtml(domain, status.dns[domain], now, notes)).join("");
}

// ---------------------------------------------------------------- 5. Receiving replies (D-1)

const OPTION_A = `<div class="card setup-option"><h3>Option A, a receive-only domain (recommended: Namecheap stays your real inbox)</h3>
  <ol class="steps">
    <li>Buy a cheap domain at Namecheap (about £5 a year), e.g. <code>aetos-mail.co.uk</code>. Never send from it or link to it.</li>
    <li>Cloudflare → Add a domain → Free plan. Then at Namecheap → Domain List → Manage → Nameservers → Custom DNS, paste Cloudflare's two nameservers.</li>
    <li>When it shows Active: Cloudflare → that domain → Email → Email Routing → Get started → Enable.</li>
    <li>Email Routing → Routing rules → Catch-all address → Edit → Action "Send to a Worker" → <code>aetos-mail-relay</code> → Save. (Or: GitHub → Settings → Secrets and variables → Actions → Variables → New: <code>INBOUND_ADDRESS</code> = <code>replies@&lt;that domain&gt;</code>, then Actions → Deploy mail relay → Run workflow.)</li>
    <li>Namecheap webmail (privateemail.com) → Settings → Forwarding → forward a copy of all mail to <code>replies@&lt;that domain&gt;</code>, and keep a copy in the inbox.</li>
    <li>Email your mailbox from your phone. Within 5 minutes "Last email received" says "just now".</li>
  </ol>
  <p class="hint">If the MX line above says Cloudflare for aetoswebsites.com: Cloudflare → aetoswebsites.com → Email → Email Routing → Settings → Disable. Add MX <code>mx1.privateemail.com</code> and <code>mx2.privateemail.com</code> (priority 10), and make hello@ an alias in Namecheap.</p></div>`;

const OPTION_B = `<div class="card setup-option"><h3>Option B, Cloudflare receives aetoswebsites.com</h3>
  <ol class="steps">
    <li>Cloudflare → aetoswebsites.com → Email → Email Routing → Enable. Remove the Namecheap MX records it lists.</li>
    <li>Routing rules → Create address: your mailbox address → "Send to a Worker" → <code>aetos-mail-relay</code>. Keep hello@ → Gmail.</li>
    <li>Optional but recommended: Destination addresses → add and verify your Gmail. Then add the GitHub repo variable <code>FORWARD_COPY_TO</code> = that Gmail and re-run Deploy mail relay, so you still get a copy of every reply.</li>
    <li>Your Namecheap inbox stops receiving mail; replies are read in the Control Room (and the Gmail copy).</li>
    <li>Test as in A6.</li>
  </ol></div>`;

/** The relay and last-email status lines, then both ways of receiving replies, side by side. */
export function receivingHtml(receiving, now = new Date()) {
  const r = receiving && typeof receiving === "object" ? receiving : {};
  const relay = r.relay_last_at ? `Mail relay checked in ${agoOr(r.relay_last_at, now)}` : "The mail relay hasn't checked in yet";
  // The relay checks in even when its calls to the Control Room fail: then it says why (e.g. error 1042).
  const problem = r.relay_ok === false ? `<div class="error">${esc(`The relay reported a problem: ${r.relay_detail || "no details"}`)}</div>` : "";
  const last = `Last email received: ${r.last_inbound_at ? agoOr(r.last_inbound_at, now) : "none yet"}`;
  return section("receiving", "Receiving replies (D-1)", `<div class="card recv-status"><div>${esc(relay)}</div>${problem}<div>${esc(last)}</div></div>
    <p class="hint">Pick one of these two and follow its steps.</p>
    <div class="grid-2 setup-options">${OPTION_A}${OPTION_B}</div>`);
}

// ---------------------------------------------------------------- 6. Claude

function routineRow(r, now, notes) {
  const name = esc(r.name);
  const connected = r.connected === true;
  const ran = r.last_beat?.at ? `Last ran ${agoOr(r.last_beat.at, now)}` : "Hasn't run yet";
  const f = r.last_fire;
  const fire = !f ? "Last fire: none yet"
    : f.ok ? `Last fire: ok (${agoOr(f.at, now)})`
    : `Last fire: ${f.error || `failed (HTTP ${f.http_status ?? "no answer"})`}`;
  const session = safeUrl(f?.session_url) ? ` <a href="${esc(safeUrl(f.session_url))}" target="_blank" rel="noopener noreferrer">Open the session</a>` : "";
  const n = notes[`rt:${r.name}`];
  return `<form class="routine setup-form" data-routine="${name}" autocomplete="off">
    <div class="routine-head"><b>${esc(r.label)}</b>${connected ? `<span class="badge good">Connected</span>` : `<span class="badge warn">Not connected</span>`}</div>
    <div class="muted small">${esc(ran)} · <span class="${f && !f.ok ? "bad-text" : ""}">${esc(fire)}</span>${session}</div>
    <div class="field-row">
      <div><label for="rt-url-${name}">Fire URL</label><input id="rt-url-${name}" name="url" inputmode="url" autocomplete="off" placeholder="${connected ? "saved ✓ (paste a new one to replace it)" : "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"}"></div>
      <div><label for="rt-token-${name}">Token</label><input id="rt-token-${name}" name="token" type="password" autocomplete="new-password" placeholder="${connected ? "saved ✓" : "sk-ant-oat01-…"}"></div>
    </div>
    <div class="actions" style="align-items:center"><button class="btn sm" type="submit">Save</button><button class="btn secondary sm" type="button" data-test-fire="${name}" ${connected ? "" : "disabled title=\"Save its URL and token first\""}>Test fire</button>${n ? note(n) : ""}</div>
    <p class="error" hidden></p></form>`;
}

/** The access key (Generate, or saved ✓ with Replace) and one row per Routine. Never a secret: only set or not. */
export function claudeHtml(status, now = new Date(), notes = {}) {
  const t = status?.agent_token || {};
  const key = t.set
    ? `<span class="ok-text">saved ✓${t.created_at ? ` (made ${esc(ukDay(t.created_at))})` : ""}</span><button class="btn secondary sm" data-agent-token="replace">Replace</button>`
    : `<span class="muted">Not made yet.</span><button class="btn sm" data-agent-token="new">Generate</button>`;
  const routines = Array.isArray(status?.routines) ? status.routines : [];
  return section("claude", "Claude", `<div class="card">
      <div class="card-head" style="margin-bottom:6px"><h2>Access key</h2></div>
      <p class="muted" style="margin-top:0">Claude's Routines use it to read and write through the Control Room.</p>
      <div class="actions" style="align-items:center">${key}</div></div>
    <div class="card routines" style="margin-top:16px">${routines.map((r) => routineRow(r, now, notes)).join("") || `<p class="muted" style="margin:0">No Routines.</p>`}</div>
    <p class="hint">How to create each Routine and get its URL and token: <a href="${REPO}/routines/README.md" target="_blank" rel="noopener noreferrer">routines/README.md</a>.</p>`);
}

// ---------------------------------------------------------------- 7. Business details (D-7)

/** The business details form (values escaped into it) and Check aetoswebsites.com. */
export function businessHtml(business, notes = {}) {
  const b = business && typeof business === "object" ? business : {};
  const input = (id, label, value, attrs) => `<div><label for="biz-${id}">${label}</label><input id="biz-${id}" name="${id}" value="${esc(value)}" ${attrs}></div>`;
  return section("business", "Business details", `<form class="card setup-form" id="biz-form" autocomplete="off">
      <p class="muted" style="margin:0">Shown in the footer of aetoswebsites.com and in its privacy notice. The law needs your full name and a business address there.</p>
      <div class="field-row">
        ${input("sender_name", "Your name as shown in emails (e.g. \"Nik\")", b.sender_name, `maxlength="100" placeholder="Nik"`)}
        ${input("legal_name", "Your full legal name (e.g. \"Nikiforos Surname\")", b.legal_name, `maxlength="200" placeholder="Nikiforos Surname"`)}
      </div>
      <div><label for="biz-address">Business address for the website (a service address is fine, not your home)</label>
        <textarea id="biz-address" name="address" rows="2" maxlength="300">${esc(b.address)}</textarea></div>
      <div class="field-row">
        ${input("contact_email", "Contact email (default hello@aetoswebsites.com)", b.contact_email, `type="email" maxlength="254" placeholder="hello@aetoswebsites.com"`)}
        ${input("ico_number", "ICO registration number (after paying the £52 fee)", b.ico_number, `maxlength="12" placeholder="ZA123456"`)}
      </div>
      <p class="error" hidden></p>
      <div class="actions" style="align-items:center"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" id="site-check">Check aetoswebsites.com</button>${notes.site ? note(notes.site) : ""}</div>
    </form>`);
}

// ---------------------------------------------------------------- 8. Payments (Stripe)

// "just now", "5 minutes ago", "2 hours ago", "3 days ago" (rounded down), or null for no time.
function longAgo(iso, now = new Date()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const min = Math.floor(Math.max(0, now.getTime() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${plural(min, "minute")} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${plural(h, "hour")} ago`;
  return `${plural(Math.floor(h / 24), "day")} ago`;
}

// The Stripe account settings Nik sets once (Part A), as [where, what] pairs; the parts in <b> are static text.
const STRIPE_CHECKLIST = [
  `${esc("Settings → Public details:")} business name <code>Aetos Websites</code>, statement descriptor <code>AETOS WEBSITES</code>, ${esc("support email, your name and service address (trading-name rule).")}`,
  `${esc("Settings → Customer emails:")} <b>Successful payments</b> and <b>Refunds</b> on. ${esc("Billing → Invoices: email finalised invoices to customers on.")}`,
  `${esc("Billing → Revenue recovery → Retries: Smart Retries on;")} <b>if all retries fail: cancel the subscription</b>.`,
  `${esc("Payment links (old system) → archive all three.")}`,
];
const STRIPE_HELP = [
  "Test mode first: pay with card 4242 4242 4242 4242, any future date, any 3 digits. When Stripe approves your account, paste the live key and press Connect Stripe again.",
  "To refund: Stripe → Payments → the payment → Refund. It shows on the Money page by itself.",
  "To stop someone's monthly: Money → their row → Stopped paying. This cancels it in Stripe too.",
];

/** The Payments (Stripe) card from /api/stripe/setup (stripeStatus, or {error}): never a key, only whether it's set. */
export function stripeHtml(stripe, now = new Date(), notes = {}) {
  const st = stripe && typeof stripe === "object" ? stripe : {};
  const row = (label, value, cls = "") => `<div class="check"><span class="dot ${cls === "ok" ? "ok" : "no"}">${cls === "ok" ? "✓" : "✕"}</span><div>${label}${value}</div></div>`;
  let rows;
  if (st.error) {
    rows = `<p class="error" style="margin:0">${esc(`Couldn't check Stripe: ${st.error}`)}</p>`;
  } else {
    const mode = st.mode === "live" ? "Live (real payments)" : "Test mode (no real money)";
    const key = st.key
      ? row(esc("Secret key: "), `<span class="ok-text">${esc(`saved ✓ · ${mode}`)}</span>${st.key_source === "cloudflare"
        ? `<div class="muted small">${esc("It's the one in Cloudflare (STRIPE_SECRET_KEY): press Connect Stripe with the field empty to use it, or paste it below to keep it here.")}</div>` : ""}`, "ok")
      : row(esc("Secret key: "), `<span class="bad-text">${esc("not added")}</span>`);
    const hook = st.webhook_current
      ? row(esc("Stripe messages (webhook): "), `<span class="ok-text">${esc("connected ✓")}</span>`, "ok")
      : row(esc("Stripe messages (webhook): "), `<span class="bad-text">${esc(st.webhook ? "needs updating: press Connect Stripe again" : "not connected: press Connect Stripe")}</span>`);
    const e = st.last_event;
    const when = e ? `${longAgo(e.at, now) || "earlier"} (${e.type})` : "none yet";
    const last = `<div class="check"><span class="dot${e ? " ok" : " muted"}">${e ? "✓" : "–"}</span><div>${esc(`Last message from Stripe: ${when}`)}${e?.result ? `<div class="muted small">${esc(e.result)}</div>` : ""}</div></div>`;
    const problem = st.last_error ? `<p class="error" style="margin:8px 0 0">${esc(st.last_error)}</p>` : "";
    rows = `<div class="checks">${key}${hook}${last}</div>${problem}`;
  }
  const n = notes.stripe;
  return section("stripe", "Payments (Stripe)", `<div class="card">${rows}</div>
    <form class="card setup-form" id="stripe-form" autocomplete="off" style="margin-top:16px">
      <div><label for="stripe-key">Stripe secret key</label><input id="stripe-key" name="key" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc("sk_test_… or rk_test_…")}"></div>
      <p class="error" hidden></p>
      <div class="actions" style="align-items:center"><button class="btn" type="submit">Connect Stripe</button>${n ? note(n) : ""}</div>
      ${STRIPE_HELP.map((t) => `<p class="hint">${esc(t)}</p>`).join("")}
    </form>
    <details class="card how" style="margin-top:16px"><summary>${esc("Stripe account settings to set once")}</summary>
      <ol class="steps">${STRIPE_CHECKLIST.map((t) => `<li>${t}</li>`).join("")}</ol></details>`);
}

// ---------------------------------------------------------------- the page

const notes = {}; // results shown under rows and forms ("mb:<id>", "rt:<name>", "dns:<domain>", "site", "stripe"), kept across redraws
let current = null; // the last /api/setup status

const head = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>`;
const foot = (label) => `<div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${esc(label)}</button></div>`;

function showError(root, message) {
  const el = root.querySelector(".error");
  if (!el) return toast(message);
  el.textContent = message;
  el.hidden = !message;
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    prompt("Copy this:", text);
  }
}

function scrollToSection(at) {
  const el = document.getElementById(`setup-${at}`);
  if (!el) return;
  if (el.tagName === "DETAILS") el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// POST JSON and read the answer as text, so a Cloudflare error page (not JSON) can still be explained.
async function postRaw(path, body) {
  const resp = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (resp.status === 401) location.href = "/login";
  return { status: resp.status, text: await resp.text() };
}

/** The Setup page. `params` may carry ?at=<section> (e.g. business) to scroll to it. */
export async function setupPage(params) {
  view.innerHTML = pageHead("Setup", "Checking what's connected…");
  await render();
  const at = params?.get?.("at");
  if (at) scrollToSection(at);
}

async function render() {
  const [setup, health, stripe] = await Promise.all([
    api("/api/setup"),
    api("/api/health").catch((err) => ({ error: err.message })),
    api("/api/stripe/setup").catch((err) => ({ error: err.message })),
  ]);
  current = setup.status || null;
  const now = new Date();
  const red = (health.lights || []).filter((l) => l.level === "red").length;
  const gaps = (setup.gaps || []).length;
  const sub = red ? `${plural(red, "red light")} below: each one says how to fix it.`
    : gaps ? `${plural(gaps, "thing")} still to set up: each section below says what to do.`
    : (setup.checks || []).every((c) => c.ok) ? "Everything is set up." : "Fix anything marked red, then refresh this page.";
  const s = current;
  view.innerHTML = `${pageHead("Setup", esc(sub))}
    <p class="hint"><a href="#/demo">Demo page</a>: approve each look and see every demo site and its views.</p>
    ${healthHtml(health)}
    ${connectionsHtml(setup.checks, setup.note)}
    ${s ? [mailboxesHtml(s, now, notes), dnsSections(s, now, notes), receivingHtml(s.receiving, now), claudeHtml(s, now, notes), businessHtml(s.business, notes)].join("")
      : section("status", "Mailboxes, DNS, Receiving replies, Claude and Business details", `<div class="card"><p class="error" style="margin:0">${esc(setup.status_error || "Couldn't read the setup status.")}</p>
        <p class="hint">Fix the Database check above, then refresh this page.</p></div>`)}
    ${stripeHtml(stripe, now, notes)}`;
  if (s) bindStatus(s);
  on("#stripe-form", "submit", (form, e) => { e.preventDefault(); connectStripe(form); });
}

// Redraw in place after an action (no "Checking…" flash, the scroll position stays).
async function refresh() {
  try {
    await render();
  } catch (err) {
    toast(err.message);
  }
}

function on(selector, event, fn) {
  view.querySelectorAll(selector).forEach((el) => el.addEventListener(event, (e) => fn(el, e)));
}

function bindStatus(s) {
  const mailbox = (id) => s.mailboxes.find((m) => m.id === id);
  on("[data-copy-text]", "click", (b) => copyText(b.dataset.copyText, "Copied. Paste it into Cloudflare."));
  on("[data-scroll]", "click", (a, e) => { e.preventDefault(); scrollToSection(a.dataset.scroll); });

  // Mailboxes
  on("[data-mb-login]", "click", (b) => testLogin(mailbox(b.dataset.mbLogin), b));
  on("[data-mb-send]", "click", (b) => askTestAddress(mailbox(b.dataset.mbSend), b));
  on("[data-mb-edit]", "click", (b) => editMailbox(mailbox(b.dataset.mbEdit)));
  on("[data-mb-status]", "click", (b) => setMailboxStatus(mailbox(b.dataset.mbStatus), b.dataset.to, b));
  on("#mb-add", "submit", (form, e) => { e.preventDefault(); addMailbox(form); });

  // DNS, Claude, Business details
  on("[data-dns]", "click", (b) => checkDns(b.dataset.dns, b));
  on("[data-agent-token]", "click", (b) => makeAgentToken(b.dataset.agentToken === "replace", b));
  on("form[data-routine]", "submit", (form, e) => { e.preventDefault(); saveRoutine(form); });
  on("[data-test-fire]", "click", (b) => testFire(b.dataset.testFire, b));
  on("#biz-form", "submit", (form, e) => { e.preventDefault(); saveBusiness(form); });
  on("#site-check", "click", (b) => siteCheck(b));
}

async function busy(button, label, work) {
  const was = button?.textContent;
  if (button) { button.disabled = true; button.textContent = label; }
  try {
    return await work();
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = was; }
  }
}

// Show a result under a mailbox row straight away (before the redraw).
function paintMailboxNote(id) {
  const el = [...view.querySelectorAll("[data-mb-result]")].find((r) => r.dataset.mbResult === id);
  if (el) el.innerHTML = note(notes[`mb:${id}`]);
}

// One press, one SMTP session: the button stays disabled until the answer is in.
async function testLogin(m, button) {
  if (!m || button?.disabled) return;
  notes[`mb:${m.id}`] = { pending: true, text: `Logging in to ${m.smtp_host || "mail.privateemail.com"}…` };
  paintMailboxNote(m.id);
  let text, ok = false;
  try {
    const { status, text: body } = await busy(button, "Testing…", () => postRaw(`/api/setup/mailboxes/${encodeURIComponent(m.id)}/test`, { action: "login" }));
    let data = null;
    try { data = JSON.parse(body); } catch { data = null; }
    if (data && typeof data === "object") {
      ok = data.ok === true;
      text = loginText(data, m);
    } else if (/\b1102\b/.test(body)) {
      text = "Cloudflare stopped this login test because it used more computer time than the free plan allows (Error 1102). That's decision D-2: the $5/month Workers Paid plan fixes it.";
    } else {
      text = `The Control Room answered HTTP ${status} instead of a result. Wait a minute and press Test login again.`;
    }
  } catch (err) {
    text = `Couldn't reach the Control Room (${err.message}). Check your connection and press Test login again.`;
  }
  notes[`mb:${m.id}`] = { ok, text };
  paintMailboxNote(m.id);
}

function askTestAddress(m, button) {
  if (!m || button?.disabled) return;
  const d = modal(`<form>${head("Send test email")}<div class="modal-body">
      <div><label for="t-to">Send a test to which address?</label><input id="t-to" type="email" required maxlength="254" value="${esc(current?.test_to)}" placeholder="you@gmail.com"></div>
      <p class="hint" style="margin:0">It goes from ${esc(m.address)} straight away.</p>
      <p class="error" hidden></p></div>${foot("Send")}</form>`);
  d.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const to = d.querySelector("#t-to").value.trim();
    d.close();
    sendTest(m, to, button);
  };
}

// Raw fetch, not api(): a send Cloudflare stops (Error 1102) answers with its own non-JSON 503 page.
// The button stays disabled until the answer is in, so one press is one email (each one counts in the SMTP proof).
async function sendTest(m, to, button) {
  if (button?.disabled) return;
  notes[`mb:${m.id}`] = { pending: true, text: `Sending a test to ${to}…` };
  paintMailboxNote(m.id);
  let outcome;
  try {
    const { status, text } = await busy(button, "Sending…", () => postRaw(`/api/setup/mailboxes/${encodeURIComponent(m.id)}/test`, { action: "send", to }));
    outcome = sendOutcome(status, text);
  } catch (err) {
    outcome = { ok: false, message: `Couldn't reach the Control Room (${err.message}). It may or may not have been sent: check the inbox, then try again.` };
  }
  notes[`mb:${m.id}`] = { ok: outcome.ok, text: outcome.message, how: outcome.ok };
  await refresh();
}

async function setMailboxStatus(m, to, button) {
  if (!m) return;
  if (to === "paused" && !confirm(`Pause ${m.address}? First emails and follow-ups from it wait until you press Resume. Replies and client mail still go.`)) return;
  try {
    await busy(button, to === "paused" ? "Pausing…" : "Resuming…", () => api(`/api/setup/mailboxes/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ status: to }) }));
    toast(to === "paused" ? `${m.address} is paused.` : `${m.address} is sending again.`);
    await refresh();
  } catch (err) {
    notes[`mb:${m.id}`] = { ok: false, text: err.message };
    paintMailboxNote(m.id);
  }
}

function editMailbox(m) {
  if (!m) return;
  const today = ukDateOf(new Date());
  const role = (v, label) => `<option value="${v}" ${m.role === v ? "selected" : ""}>${label}</option>`;
  const d = modal(`<form autocomplete="off">${head(`Edit ${m.address}`)}<div class="modal-body">
      <div><label for="e-name">Name shown in emails</label><input id="e-name" required maxlength="100" value="${esc(m.display_name)}"></div>
      <div class="field-row">
        <div><label for="e-role">Role</label><select id="e-role">${role("cold", "Cold")}${role("system", "System")}</select></div>
        <div><label for="e-started">The date you bought it</label><input id="e-started" type="date" required value="${esc(m.started_on)}" max="${esc(today)}"></div>
        <div><label for="e-cap">Cold emails a day</label><input id="e-cap" inputmode="numeric" value="${esc(m.cap_override ?? "")}" placeholder="warm-up"></div>
      </div>
      <p class="hint" style="margin:0">Leave "Cold emails a day" empty to follow the warm-up: none for 14 days, then 3, 5, 8 and 10 a day.</p>
      <div><label for="e-password">Password</label><input id="e-password" type="password" autocomplete="new-password" placeholder="${m.has_password ? "saved ✓ (leave empty to keep it)" : "missing: paste it from Namecheap"}"></div>
      <p class="error" hidden></p></div>${foot("Save")}</form>`);
  const form = d.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const cap = form.querySelector("#e-cap").value.trim();
    const body = {
      display_name: form.querySelector("#e-name").value,
      role: form.querySelector("#e-role").value,
      started_on: form.querySelector("#e-started").value,
      cap_override: cap === "" ? null : cap,
    };
    const password = form.querySelector("#e-password").value;
    if (password) body.password = password;
    try {
      // Never send status from here: Pause and Resume are their own buttons.
      await busy(form.querySelector("button[type=submit]"), "Saving…", () => api(`/api/setup/mailboxes/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify(body) }));
      d.close();
      toast("Mailbox saved.");
      await refresh();
    } catch (err) {
      showError(form, err.message);
    }
  };
}

async function addMailbox(form) {
  const body = {
    address: form.querySelector("#mb-address").value.trim(),
    display_name: form.querySelector("#mb-name").value,
    role: form.querySelector("#mb-role").value,
    started_on: form.querySelector("#mb-started").value,
  };
  const password = form.querySelector("#mb-password").value;
  if (password) body.password = password;
  showError(form, "");
  try {
    await busy(form.querySelector("button[type=submit]"), "Adding…", () => api("/api/setup/mailboxes", { method: "POST", body: JSON.stringify(body) }));
    toast(password ? "Mailbox added. Press Test login next." : "Mailbox added. Add its password with Edit, then press Test login.");
    await refresh();
  } catch (err) {
    showError(form, err.message);
  }
}

async function checkDns(domain, button) {
  try {
    await busy(button, "Checking…", () => api(`/api/setup/dns?domain=${encodeURIComponent(domain)}`));
    delete notes[`dns:${domain}`];
  } catch (err) {
    notes[`dns:${domain}`] = { ok: false, text: err.message };
  }
  await refresh();
}

function showToken(token) {
  const d = modal(`${head("Claude's access key")}<div class="modal-body">
      <code class="token">${esc(token)}</code>
      <p style="margin:0">${esc(TOKEN_ONCE)}</p></div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-close>Done</button><button type="button" class="btn" id="token-copy">Copy</button></div>`);
  d.querySelector("#token-copy").onclick = () => copyText(token, "Copied. Paste it into the Claude environment now.");
  d.addEventListener("close", refresh);
}

async function makeAgentToken(replace, button) {
  if (replace && !confirm("Make a new access key? The old one stops working straight away, so every Routine stops until you paste the new key into the Claude environment.")) return;
  try {
    const { token } = await busy(button, "Making…", () => api("/api/setup/agent-token", { method: "POST" }));
    showToken(token);
  } catch (err) {
    toast(err.message);
  }
}

async function saveRoutine(form) {
  const name = form.dataset.routine;
  const label = current?.routines?.find((r) => r.name === name)?.label || name;
  const url = form.elements.namedItem("url").value.trim();
  const token = form.elements.namedItem("token").value.trim();
  showError(form, "");
  try {
    const { connected } = await busy(form.querySelector("button[type=submit]"), "Saving…",
      () => api(`/api/setup/routines/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ url, token }) }));
    notes[`rt:${name}`] = { ok: true, text: connected ? "Saved. Press Test fire to check it." : "Saved. Paste the other one too (the URL and the token are both needed)." };
    toast(connected ? `The ${label} Routine is connected.` : "Saved.");
    await refresh();
  } catch (err) {
    showError(form, err.message);
  }
}

async function testFire(name, button) {
  const label = current?.routines?.find((r) => r.name === name)?.label || name;
  try {
    const r = await busy(button, "Firing…", () => api(`/api/setup/routines/${encodeURIComponent(name)}/test`, { method: "POST" }));
    notes[`rt:${name}`] = r.ok
      ? { ok: true, text: `Fired. Claude is starting the ${label} Routine: "Last ran" changes when it checks in, usually within a few minutes.`, link: safeUrl(r.session_url) }
      : { ok: false, text: r.error || `Claude didn't start it (HTTP ${r.status}).` };
  } catch (err) {
    notes[`rt:${name}`] = { ok: false, text: err.message };
  }
  await refresh();
}

async function saveBusiness(form) {
  const field = (name) => form.elements.namedItem(name).value;
  const body = Object.fromEntries(["sender_name", "legal_name", "address", "contact_email", "ico_number"].map((k) => [k, field(k)]));
  showError(form, "");
  try {
    const saved = await busy(form.querySelector("button[type=submit]"), "Saving…", () => api("/api/setup/business", { method: "PUT", body: JSON.stringify(body) }));
    window.dispatchEvent(new CustomEvent("aetos:business", { detail: { complete: saved.complete === true } }));
    toast(saved.complete ? "Business details saved." : "Saved. Your full legal name and the address are still needed.");
    await refresh();
  } catch (err) {
    showError(form, err.message);
  }
}

async function siteCheck(button) {
  try {
    const r = await busy(button, "Checking…", () => api("/api/setup/site-check", { method: "POST" }));
    notes.site = { ok: r.ok === true, text: r.message };
  } catch (err) {
    notes.site = { ok: false, text: err.message };
  }
  await refresh();
}

// Connect Stripe: the key goes to the server once (never kept in the page); the answer is the new status.
async function connectStripe(form) {
  const input = form.elements.namedItem("key");
  const key = input.value.trim();
  showError(form, "");
  try {
    const st = await busy(form.querySelector("button[type=submit]"), "Connecting…",
      () => api("/api/stripe/setup", { method: "POST", body: JSON.stringify({ key }) }));
    input.value = "";
    const mode = st.mode === "live" ? "live mode (real payments)" : "test mode";
    notes.stripe = { ok: true, text: `Connected in ${mode}. Stripe's payment messages now come here.` };
    toast("Stripe connected.");
    await refresh();
  } catch (err) {
    showError(form, err.message);
  }
}
