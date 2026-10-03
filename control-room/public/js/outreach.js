// Outreach page: the running test, versions waiting for approval, fixed follow-ups, past tests, who can be emailed.
import { api, esc, fmtDate, icon, kpi, modal, pageHead, state, toast, view } from "./lib.js";

const STATUS_BADGE = {
  live: ["good", "Live"], proposed: ["warn", "Waiting for you"], paused: ["bad", "Paused"],
  retired: ["", "Retired"], rejected: ["", "Rejected"],
};
const AUTHOR = { seed: "Starter", claude: "Claude", owner: "You" };
const STEP_LABEL = { 1: "First email", 2: "Follow-up · day 3", 3: "Follow-up · day 7", 4: "Polite close · day 14" };
const pct = (x) => `${(100 * x).toFixed(1)}%`;

export async function outreachPage() {
  const d = (state.outreach = await api("/api/outreach"));
  const live1 = d.stats.filter((s) => s.status === "live");
  const proposals = d.versions.filter((v) => v.status === "proposed");
  const senderOk = d.sender.name && d.sender.address;
  const e = d.eligibility;

  view.innerHTML = `
    ${pageHead("Outreach", "Emails that improve themselves: two versions of the first email compete, the better one wins, Claude writes the next challenger, you approve it.",
      `<button class="btn" id="new-version">${icon("plus")} Write a version</button>`)}
    <div class="kpis">
      ${kpi("Sending", d.sendingConnected ? "On" : "Not connected", d.sendingConnected ? "" : "Connects when your mailboxes are warmed up", d.sendingConnected ? "accent" : "")}
      ${kpi("Can be emailed now", e.eligible, `of ${e.total} leads (limited companies only)`)}
      ${kpi("Versions in the test", live1.length, live1.length < 2 ? "Approve 2 to start testing" : "Competing for new leads")}
      ${kpi("Waiting for you", proposals.length, proposals.length ? "Approve or reject below" : "Nothing to approve")}
    </div>
    ${senderOk ? "" : senderCard(d.sender)}
    ${testCard(d)}
    ${proposals.length ? `<div class="section-title"><h2>Waiting for your approval</h2><span class="muted small">Each is shown on your real leads with the quality check</span></div>
      <div class="stack">${proposals.map(proposalCard).join("")}</div>` : ""}
    ${followupsCard(d)}
    <div class="grid-2" style="margin-top:16px">${eligibilityCard(e)}${pastCard(d)}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Every email ends with</h2>
      <button class="btn ghost sm" id="edit-sender">Edit sender</button></div>
      <pre class="email-pre">${esc(d.footer)}</pre>
      <p class="hint">Required by UK law (who's writing, where their details came from, how to opt out). Versions can't change it.</p></div>`;
  bind(d);
}

function senderCard(sender) {
  return `<div class="card" style="margin-top:16px;border-color:var(--gold-line)"><div class="card-head"><h2>Who are the emails from?</h2></div>
    <p class="muted" style="margin-top:0">UK law needs your name and a business address in every email. A virtual office address keeps your home private.</p>
    <form id="sender-form" class="field-row">
      <div><label for="s-name">Name (as the law needs it)</label><input id="s-name" placeholder="N. Surname" value="${esc(sender.name || "")}" required></div>
      <div><label for="s-first">You sign emails as</label><input id="s-first" placeholder="Nik" value="${esc(sender.first || "")}" required></div>
      <div style="grid-column:1/-1"><label for="s-address">Business address</label><input id="s-address" placeholder="Virtual office address" value="${esc(sender.address || "")}" required></div>
      <div><button class="btn" type="submit">Save</button></div>
    </form><p class="error" id="sender-error" hidden></p></div>`;
}

function testCard(d) {
  const name = (id) => d.versions.find((v) => v.id === id);
  if (!d.test) {
    return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>No test running yet</h2></div>
      <p class="muted" style="margin:0">Approve two first-email versions below and the test starts. New leads are split between them automatically.</p></div>`;
  }
  const rows = d.stats.map((s) => {
    const v = name(s.id) || {};
    const [cls, label] = STATUS_BADGE[s.status] || ["", s.status];
    const kept = d.tests.some((t) => t.kept_id === s.id);
    return `<tr class="click" data-version="${esc(s.id)}">
      <td><div class="biz">${esc(v.name)}${kept ? ' <span class="badge gold plain">Champion</span>' : ""}</div><div class="sub-line">${esc(v.hypothesis || "")}</div></td>
      <td><span class="badge ${cls}">${label}</span>${v.status_reason ? `<div class="sub-line">${esc(v.status_reason)}</div>` : ""}</td>
      <td class="r num">${s.sends}</td><td class="r num">${s.counted}</td><td class="r num">${s.positive}</td>
      <td class="r num">${s.counted ? pct(s.positive / s.counted) : "–"}</td>
      <td class="r num">${s.pbest === null ? "–" : `${Math.round(100 * s.pbest)}%`}</td></tr>`;
  }).join("");
  const live = d.stats.filter((s) => s.status === "live");
  const minCounted = live.length ? Math.min(...live.map((s) => s.counted)) : 0;
  const weeks = (Date.now() - Date.parse(d.test.started_at)) / (7 * 86400000);
  const progress = Math.min(100, Math.max((100 * minCounted) / 250, (100 * weeks) / 8));
  return `<div class="table-card" style="margin-top:16px">
    <div class="card-head" style="padding:18px 20px 0"><div><h2>Current test</h2><div class="muted small">Started ${esc(fmtDate(d.test.started_at, true))} · decides at 250 counted emails each, or after 8 weeks</div></div>
      <span class="muted small num">${Math.round(progress)}% of the way</span></div>
    <div style="padding:10px 20px 0"><div class="progress"><i style="width:${progress}%"></i></div></div>
    <div class="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th class="r">Sent</th><th class="r">Counted</th><th class="r">Positive</th><th class="r">Rate</th><th class="r">Chance best</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="empty">Approve versions below.</td></tr>`}</tbody></table></div>
    <p class="hint" style="padding:0 20px 16px">"Counted" = first emails at least 10 days old (or replied to). A positive reply is Interested or a genuine Question. Click a version to see it.</p>
  </div>`;
}

function proposalCard(v) {
  return `<div class="card"><div class="card-head"><div><h2>${esc(v.name)}</h2>
      <div class="muted small">${esc(STEP_LABEL[v.step])} · written by ${esc(AUTHOR[v.author] || v.author)}</div></div>
      <div class="actions"><button class="btn secondary sm" data-reject="${esc(v.id)}">Reject</button><button class="btn sm" data-approve="${esc(v.id)}">Approve</button></div></div>
    ${v.hypothesis ? `<p style="margin-top:0"><b>Idea:</b> ${esc(v.hypothesis)}</p>` : ""}
    <div class="preview" data-preview="${esc(v.id)}"><p class="muted small">Rendering on your leads…</p></div>
  </div>`;
}

function followupsCard(d) {
  const steps = [2, 3, 4].map((step) => {
    const live = d.versions.filter((v) => v.step === step && v.status === "live");
    return `<div class="fu"><div class="muted small" style="font-weight:600">${STEP_LABEL[step]}</div>${live.length
      ? live.map((v) => `<div class="fu-v" data-version="${esc(v.id)}">${esc(v.name)}</div>`).join("")
      : `<div class="faint small">Not approved yet</div>`}</div>`;
  }).join("");
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Follow-ups (same for everyone)</h2>
    <span class="muted small">Fixed until the first email has had 2 tests</span></div><div class="fu-row">${steps}</div>
    <p class="hint">Sent in the same email thread on day 3, 7 and 14. Any reply stops them. A version that needs Google Maps data falls back to the next one.</p></div>`;
}

function eligibilityCard(e) {
  return `<div class="card"><div class="card-head"><h2>Who can be emailed</h2><span class="muted small num">${e.eligible} of ${e.total}</span></div>
    <p class="muted" style="margin-top:0">UK law lets you cold email limited companies with an opt-out, but sole traders need consent first. Everyone else goes on the call list.</p>
    <div class="cost-rows">${e.reasons.slice(0, 7).map(([reason, n]) => `<div class="cost-row"><span>${esc(reason)}</span><b class="num">${n}</b></div>`).join("") || `<p class="muted">No leads yet.</p>`}</div></div>`;
}

function pastCard(d) {
  return `<div class="card"><div class="card-head"><h2>Past tests</h2></div>
    ${d.tests.length ? `<div class="cost-rows">${d.tests.map((t) => `<div><div class="small faint">${esc(fmtDate(t.ended_at, true))}</div><div class="small">${esc(t.summary)}</div></div>`).join("")}</div>`
      : `<p class="muted" style="margin:0">Each finished test is logged here, so ideas that lost aren't tried again.</p>`}</div>`;
}

function emailHtml(p) {
  return `<div class="email"><div class="email-head"><span class="faint small">To ${esc(p.name)}</span>${p.subject ? `<b>${esc(p.subject)}</b>` : ""}</div>
    <pre class="email-pre">${esc(p.body)}</pre>
    ${p.issues.length ? `<div class="small down">This lead would get another version instead:</div><ul class="issues">${p.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<div class="small up">${icon("check")} Passes the quality check</div>`}</div>`;
}

async function fillPreview(el, id) {
  try {
    const { previews, issues } = await api(`/api/outreach/versions/${encodeURIComponent(id)}`);
    const template = issues.filter((i) => i.startsWith("Template:"));
    el.innerHTML = (template.length ? `<ul class="issues">${template.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "") +
      (previews.length ? `<div class="email-grid">${[...previews.filter((p) => !p.issues.length), ...previews.filter((p) => p.issues.length)].slice(0, 2).map(emailHtml).join("")}</div>${previews.length > 2 ? `<p class="hint">Checked on ${previews.length} of your leads.</p>` : ""}`
        : `<p class="muted small">None of your leads have the details this version needs yet (e.g. a Google Maps heatmap).</p>`);
  } catch (err) {
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function act(id, action) {
  try {
    await api(`/api/outreach/versions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
    toast(action === "approve" ? "Approved: it's live." : "Done.");
    await outreachPage();
  } catch (err) {
    const issues = err.issues || [];
    alert(`${err.message}${issues.length ? `\n\n${issues.join("\n")}` : ""}`);
  }
}

function showVersion(id) {
  const v = state.outreach.versions.find((x) => x.id === id);
  if (!v) return;
  const d = modal(`<div class="modal-head"><h2>${esc(v.name)}</h2><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">${v.hypothesis ? `<p style="margin:0"><b>Idea:</b> ${esc(v.hypothesis)}</p>` : ""}
      ${v.subject ? `<div><label>Subject</label><div>${esc(v.subject)}</div></div>` : ""}
      <div><label>Template</label><pre class="email-pre">${esc(v.body)}</pre></div>
      <div data-preview="${esc(v.id)}"><p class="muted small">Rendering…</p></div></div>
    <div class="modal-foot">${v.status === "live" ? `<button class="btn secondary" data-act="pause">Pause</button><button class="btn danger" data-act="retire">Retire</button>`
      : v.status === "paused" ? `<button class="btn" data-act="resume">Resume</button><button class="btn danger" data-act="retire">Retire</button>` : ""}
      <button class="btn ghost" data-close>Close</button></div>`);
  d.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => { d.close(); act(v.id, b.dataset.act); });
  fillPreview(d.querySelector("[data-preview]"), v.id);
}

function writeVersion() {
  const d = modal(`<form><div class="modal-head"><h2>Write a version</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">
      <div class="field-row"><div><label for="w-step">Which email</label><select id="w-step">${[1, 2, 3, 4].map((s) => `<option value="${s}">${STEP_LABEL[s]}</option>`).join("")}</select></div>
        <div><label for="w-name">Short name</label><input id="w-name" required placeholder="Lead with their reviews"></div></div>
      <div><label for="w-hyp">The idea being tested</label><input id="w-hyp" placeholder="Mentioning their good reviews first gets more replies"></div>
      <div id="w-subject-wrap"><label for="w-subject">Subject</label><input id="w-subject" placeholder="{business} on Google"></div>
      <div><label for="w-body">Email</label><textarea id="w-body" rows="9" required placeholder="{greeting}\n\n…\n\n{sender_first}"></textarea>
        <p class="hint">Placeholders: {greeting} {business} {town} {trade} {problem} {top3} {competitor} {competitor_top3} {spots} {rating} {reviews} {sender_first}</p></div>
      <p class="error" hidden></p>
    </div><div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save as proposal</button></div></form>`);
  const step = d.querySelector("#w-step");
  step.onchange = () => { d.querySelector("#w-subject-wrap").hidden = step.value !== "1"; };
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const err = d.querySelector(".error");
    try {
      await api("/api/outreach/versions", { method: "POST", body: JSON.stringify({
        step: Number(step.value), name: d.querySelector("#w-name").value, hypothesis: d.querySelector("#w-hyp").value,
        subject: d.querySelector("#w-subject").value, body: d.querySelector("#w-body").value,
      }) });
      d.close();
      toast("Saved. Check it on your leads below, then approve.");
      await outreachPage();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}

function bind(d) {
  view.querySelector("#new-version").onclick = writeVersion;
  view.querySelectorAll("[data-approve]").forEach((b) => b.onclick = () => act(b.dataset.approve, "approve"));
  view.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => act(b.dataset.reject, "reject"));
  view.querySelectorAll("[data-preview]").forEach((el) => fillPreview(el, el.dataset.preview));
  view.querySelectorAll("[data-version]").forEach((el) => el.onclick = () => showVersion(el.dataset.version));
  const form = view.querySelector("#sender-form");
  const editSender = view.querySelector("#edit-sender");
  editSender.onclick = () => {
    if (form) return form.scrollIntoView({ behavior: "smooth" });
    const m = modal(`<div class="modal-head"><h2>Sender</h2><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div><div class="modal-body">${senderCard(d.sender)}</div>`);
    bindSender(m);
  };
  if (form) bindSender(view);
}

function bindSender(root) {
  const form = root.querySelector("#sender-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = root.querySelector("#sender-error");
    try {
      await api("/api/outreach/settings", { method: "PUT", body: JSON.stringify({
        name: root.querySelector("#s-name").value, first: root.querySelector("#s-first").value, address: root.querySelector("#s-address").value,
      }) });
      root.closest?.("dialog")?.close();
      toast("Saved.");
      await outreachPage();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}
