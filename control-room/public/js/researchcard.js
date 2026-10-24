// Claude's research card in the lead drawer (stage 2, docs/rebuild/03-research-grade.md "What Nik sees"). Pure: it
// turns the answer of GET /api/research/<place_id> ({research: the parsed row or null, waiting: leads queued}) into
// HTML and never reads or writes the page, so it's tested in node (tests/researchcard.test.mjs) and stage 3's drawer
// embeds it unchanged. esc and safeUrl are passed in (lib.js's), because lib.js reads the page when it loads.
// Scraped and Claude-written text is untrusted: every value goes through esc(), every link through safeUrl() (http(s)
// only; anything else stays plain text). leads.js wires the buttons: Copy and "Research is wrong".

const POINTS = [["need", "Need"], ["means", "Means"], ["reach", "Reach"], ["fit", "Fit"]];
const CAPS = { reach: "no email that reaches the owner", fit: "not a fit", too_big: "too big for us" };
const NIK = /^\s*\[Nik ([^\]]*)\]\s*/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NOT_A_FIT = /^not a fit\b\s*:?\s*/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : []);
const noteLines = (notes) => (typeof notes === "string" ? notes.replace(/\r\n?/g, "\n").split("\n") : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** What shows under the note box when "Research is wrong" can't reach the Control Room at all (Part A, exactly). */
export const RECHECK_OFFLINE = "Couldn't save. Check your connection and press Re-check again.";

/**
 * The answer of POST /api/research/<place_id>/wrong → {message} (the toast: the route's own text) or {error} (in plain
 * English, for under the box). status = the HTTP status, data = the JSON body or null (not JSON). The route's 400 and
 * 404 texts are shown as they are; a server failure (5xx, or an answer that isn't the route's) says so and what to do.
 */
export function recheckAnswer(status, data) {
  const body = isObj(data) ? data : {};
  if (status >= 200 && status < 300 && body.ok === true) return { message: str(body.message) || "Queued." };
  const said = str(body.error);
  if (said && status >= 400 && status < 500) return { error: said };
  const why = said ? said.replace(/\s+/g, " ").slice(0, 200).replace(/[.\s]+$/, "") : `HTTP ${status}`;
  return { error: `Couldn't save: the Control Room had a problem (${why}). Press Re-check again in a minute.` };
}

/** "Capped at C: no email that reaches the owner" (reach), "Capped at D: not a fit" (fit), "Capped at D: too big for us" (too_big); "" for no cap. */
export function capLine(capped, grade) {
  if (typeof capped !== "string" || !Object.hasOwn(CAPS, capped)) return "";
  return `Capped at ${grade || (capped === "reach" ? "C" : "D")}: ${CAPS[capped]}`;
}

// Nik's note lines, "[Nik YYYY-MM-DD] …", in order: {day ("" when it isn't a date, so it counts as the oldest), text}.
function nikNotes(notes) {
  const out = [];
  for (const line of noteLines(notes)) {
    const m = NIK.exec(line);
    const text = m ? line.slice(m[0].length).trim() : "";
    if (text) out.push({ day: DAY.test(m[1]) ? m[1] : "", text });
  }
  return out;
}

// The newest note: the latest date; on the same day the line higher up (every writer puts the new line on top). The
// same rule as research.js latestNikNote, which the server uses.
function newest(notes) {
  let best = null;
  for (const n of notes) if (!best || n.day > best.day) best = n;
  return best;
}

// Why a skipped lead was skipped: Nik's "Not a fit" when that's his newest note, else the newest "Skipped: …" line
// (the queue adds them at the bottom; file 11's purge leaves only its own), else an older "Not a fit" of his.
function skippedLine(notes) {
  const nik = nikNotes(notes);
  const fitLine = (n) => {
    const why = n.text.replace(NOT_A_FIT, "").replace(/[.\s]+$/, "");
    return why ? `Skipped: you marked it not a fit (${why}).` : "Skipped: you marked it not a fit.";
  };
  const latest = newest(nik);
  if (latest && NOT_A_FIT.test(latest.text)) return fitLine(latest);
  const skip = noteLines(notes).map((s) => s.trim()).filter((s) => /^Skipped:\s*\S/.test(s)).pop();
  if (skip) return sentence(skip);
  const fit = newest(nik.filter((n) => NOT_A_FIT.test(n.text)));
  return fit ? fitLine(fit) : "Skipped: no reason was saved.";
}

// "2026-10-19" in the UK (the date the server puts on Nik's line).
function ukDay(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// "19 Oct": the UK day of an ISO time, or "" when there's none.
function ukShort(isoTime) {
  const d = typeof isoTime === "string" && isoTime ? new Date(isoTime) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
}

/**
 * The research row as it is right after "Research is wrong" succeeded, so the card can switch to "Being re-checked…"
 * without asking the server again: status 'queued' and Nik's line on top of the notes, written the way the server
 * writes it ("[Nik <UK date>] <note on one line>"). Everything else (the old grade and findings) stays.
 */
export function recheckedResearch(research, note, now = new Date()) {
  const r = isObj(research) ? research : {};
  const line = `[Nik ${ukDay(now)}] ${String(note ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()}`;
  const old = str(r.notes);
  return { ...r, status: "queued", notes: old ? `${line}\n${old}` : line };
}

/**
 * The "Claude's research" section for one lead. data = {research, waiting} from GET /api/research/<place_id>;
 * h = {esc, safeUrl} from lib.js. States (Part A): no row, waiting for Claude, being re-checked (the old research
 * below, faded), skipped (with its reason), done (the full card). "Research is wrong" is on the done and skipped cards
 * (it's the only way back for a skipped lead: after Not a fit, the 12-month purge, or a lead the scraper excluded or
 * lost but keeps again); leads.js shows its note box. The route itself refuses a lead Claude may not research now
 * (still excluded, deleted, or on the do-not-contact list) with a 409/404 whose text shows under the box (recheckAnswer).
 */
export function researchCard(data, { esc, safeUrl }) {
  const h = { esc, safeUrl };
  const r = isObj(data?.research) ? data.research : null;
  const section = (body) => `<h3 class="research-head">Claude's research</h3><div class="research-card">${body}</div>`;
  if (!r) return section(`<p class="muted">Not queued for research. Leads are queued when the daily search keeps them.</p>`);

  if (r.status === "skipped") return section(`<p class="research-state">${esc(skippedLine(r.notes))}</p>${wrongBox()}`);
  if (r.status === "queued") {
    const note = newest(nikNotes(r.notes));
    const researched = !!str(r.researched_at);
    if (!researched && !note) {
      const n = Number(data.waiting);
      const waiting = Number.isInteger(n) && n > 0 ? ` ${plural(n, "lead", "leads")} waiting.` : "";
      return section(`<p class="research-state muted">Waiting for Claude. It researches 8 leads a run, every morning at 06:47 and after each search.${waiting}</p>`);
    }
    const line = note ? `Being re-checked after your note: “${esc(note.text)}”.` : "Being re-checked.";
    return section(`<p class="research-state">${line}</p>${researched ? `<div class="research-old">${fullCard(r, h)}</div>` : ""}`);
  }
  return section(`${fullCard(r, h)}${wrongBox()}`);
}

// The done card, top to bottom as Part A lists it (the Research is wrong box comes after it).
function fullCard(r, { esc, safeUrl }) {
  const source = (u) => {
    const href = safeUrl(u);
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">source</a>` : "";
  };
  const block = (title, body) => (body ? `<h4>${title}</h4>${body}` : "");
  const p = isObj(r.points) ? r.points : {};
  const reasons = isObj(p.reasons) ? p.reasons : {};
  const value = (k) => (Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 5 ? p[k] : null);
  const sum = POINTS.every(([k]) => value(k) !== null) ? POINTS.reduce((t, [k]) => t + value(k), 0) : null;
  const total = Number.isInteger(p.total) ? p.total : sum;

  // 1. Grade · total · date, the too-big tag and the cap.
  const grade = str(r.grade);
  const researched = ukShort(r.researched_at);
  const cap = capLine(p.capped, grade);
  const head = `<div class="grade-row"><span class="grade${grade === "A+" ? " aplus" : ""}">${esc(grade || "–")}</span>
    ${total !== null ? `<b class="num">${esc(total)}/20</b>` : ""}
    ${researched ? `<span class="muted small">Researched ${esc(researched)}</span>` : ""}
    ${r.too_big === true ? `<span class="tag">Too big for us</span>` : ""}</div>
    ${cap ? `<p class="small muted research-cap">${esc(cap)}</p>` : ""}`;

  // 2. Points: "Need 5/5 · <reason>", a bar each.
  const points = `<div class="points">${POINTS.map(([k, label]) => {
    const v = value(k);
    const why = str(reasons[k]);
    return `<div class="point"><div><b>${label} ${v === null ? "–" : v}/5</b>${why ? ` · <span class="why">${esc(why)}</span>` : ""}</div>
      <div class="bar"><i style="width:${(v || 0) * 20}%"></i></div></div>`;
  }).join("")}</div>`;

  // 3–5. Why, how we can help, the suggested opener.
  const why = str(r.grade_reason) ? `<p>${esc(r.grade_reason)}</p>` : "";
  const angle = list(r.angle).filter((a) => isObj(a) && str(a.fact));
  const help = angle.length ? `<ul class="research-list">${angle.map((a) => {
    const src = source(a.source_url);
    return `<li>${esc(a.fact)}${src ? ` · ${src}` : ""}</li>`;
  }).join("")}</ul>` : "";
  const opener = str(r.opener) ? `<blockquote class="opener-box">${noteLines(r.opener).map(esc).join("<br>")}</blockquote>
    <button class="btn secondary sm" data-copy-opener>Copy</button>` : "";

  // 6. Owner (Part A): "Dave Smith · confirmed (source)", or the first name the emails would have used, "Dave · not
  // confirmed: emails say "Hi,"" (with its source too, so Nik can check it), or "Not found".
  const o = isObj(r.owner) ? r.owner : null;
  const sure = o?.confident === true;
  const name = !o ? "" : sure ? str(o.full) || str(o.first) : str(o.first) || str(o.full);
  const ownerSrc = o ? source(o.source_url) : "";
  const owner = !name ? `<p>Not found</p>`
    : `<p>${esc(name)} · ${esc(sure ? "confirmed" : `not confirmed: emails say "Hi,"`)}${ownerSrc ? ` (${ownerSrc})` : ""}</p>`;

  // 7. Emails, the best one first and starred with why.
  const best = str(r.best_email).toLowerCase();
  const emails = list(r.emails).filter((e) => isObj(e) && str(e.email));
  if (best && !emails.some((e) => str(e.email).toLowerCase() === best)) emails.unshift({ email: best });
  emails.sort((a, b) => (str(b.email).toLowerCase() === best) - (str(a.email).toLowerCase() === best));
  const searched = list(r.searched).filter((s) => str(s));
  const emailList = emails.length ? `<ul class="research-list emails">${emails.map((e) => {
    const isBest = !!best && str(e.email).toLowerCase() === best;
    const src = source(e.source_url);
    return `<li${isBest ? ` class="best"` : ""}>${isBest ? `<span class="star" title="Best email">★</span> ` : ""}<a href="mailto:${esc(str(e.email))}">${esc(str(e.email))}</a>${str(e.where) ? ` · ${esc(e.where)}` : ""}${src ? ` · ${src}` : ""}
      ${isBest && str(r.best_email_why) ? `<div class="small muted">${esc(r.best_email_why)}</div>` : ""}</li>`;
  }).join("")}</ul>`
    : `<p class="muted">No email found.${searched.length ? ` Claude checked ${plural(searched.length, "place", "places")} (see below).` : ""}</p>`;

  // 8. Their website (only when Claude opened it).
  const sr = isObj(r.site_review) ? r.site_review : null;
  const problems = sr ? list(sr.problems).filter((s) => str(s)) : [];
  const good = sr ? list(sr.good).filter((s) => str(s)) : [];
  const site = sr ? `${str(sr.verdict) || str(sr.summary) ? `<p>${str(sr.verdict) ? `<b>${esc(sentence(str(sr.verdict)))}</b> ` : ""}${esc(str(sr.summary))}</p>` : ""}
    ${problems.length ? `<ul class="issues">${problems.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
    ${good.length ? `<p class="small muted">Good: ${good.map(esc).join(" · ")}</p>` : ""}` : "";

  // 9–10. Notes as plain text; what Claude checked, collapsed.
  const notes = str(r.notes) ? `<p class="research-notes">${esc(str(r.notes))}</p>` : "";
  const checked = searched.length ? `<details class="research-checked"><summary>What Claude checked (${searched.length})</summary>
    <ol>${searched.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></details>` : "";

  return `${head}${points}${block("Why", why)}${block("How we can help", help)}${block("Suggested opener", opener)}
    ${block("Owner", owner)}${block("Emails", emailList)}${block("Their website", site.trim())}${block("Notes", notes)}${checked}`;
}

// 11. "Research is wrong": the button, and its note box (hidden until pressed; leads.js shows it and posts the note).
function wrongBox() {
  return `<div class="recheck">
    <button class="btn secondary sm" data-recheck-open>Research is wrong</button>
    <div class="recheck-box" data-recheck-box hidden>
      <label for="d-recheck-note">What's wrong? Claude reads this when it re-checks.</label>
      <textarea id="d-recheck-note" rows="3" data-recheck-note></textarea>
      <div class="actions"><button class="btn sm" data-recheck-send>Re-check</button><button class="btn secondary sm" data-recheck-cancel>Cancel</button></div>
      <p class="error" data-recheck-error hidden></p>
    </div>
  </div>`;
}
