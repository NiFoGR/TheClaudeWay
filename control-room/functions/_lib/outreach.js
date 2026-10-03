// Outreach engine: fill templates from audit facts, the quality gate, who may be emailed, and the test decisions.
// Pure functions (no database), so everything here is unit-tested. Design: docs/outreach-experiments.md

import { probBest, thompsonPick } from "./bandit.js";

// ---------------------------------------------------------------- numbers from the reviewed design (§4)

export const RULES = {
  priorA: 1,
  priorB: 49,              // "about 2%, worth 50 emails of evidence"
  creditDays: 10,          // a positive reply within 10 days of the first email counts for its version
  floorUntil: 150,         // versions with fewer counted emails get at least 25% of new leads
  floorShare: 0.25,
  decideAt: 250,           // test ends when every version has 250 counted emails…
  maxTestDays: 56,         // …or after 8 weeks
  retireBelow: 0.02,       // drop early only if chance of being best < 2% with 250+ counted
  guardMinSends: 60,
  guardMinNegatives: 4,
  guardRate: 0.04,
  maxLive: 3,
};

export const STEPS = [
  { step: 1, day: 0, label: "First email", maxWords: 90 },
  { step: 2, day: 3, label: "Follow-up", maxWords: 60 },
  { step: 3, day: 7, label: "Follow-up", maxWords: 60 },
  { step: 4, day: 14, label: "Polite close", maxWords: 60 },
];

export const POSITIVE = ["interested", "question"];
export const NEGATIVE = ["no", "opt_out", "complaint"];

// ---------------------------------------------------------------- facts from a lead (only what the audit proved)

const TITLE_SMALL = new Set(["and", "of", "the", "in", "on", "at", "for", "to", "&"]);

export function titleCase(s) {
  return String(s || "").toLowerCase().split(/(\s+|-)/).map((w, i) =>
    (i > 0 && TITLE_SMALL.has(w)) || /^\s+$|^-$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** "SMITH ROOFING LTD - Roofer in Leeds" → "Smith Roofing" */
export function cleanBusiness(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim();
  n = n.replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

// What each audit finding sounds like in an email: gentle and factual, never "your site is bad".
const PROBLEMS = [
  ["no_website", "I couldn't find a website for {business}"],
  ["profile_only", "When I searched for {business}, I could only find a listing page, not your own website"],
  ["site_down", "Your website wouldn't load when I tried it today"],
  ["site_broken", "Your website wouldn't load properly when I tried it today"],
  ["bad_certificate", "Chrome shows a security warning before your website opens"],
  ["maps_invisible", "When I searched \"{trade}\" around {town}, {business} didn't come up in Google's top 20"],
  ["maps_no_top3", "When I searched \"{trade}\" around {town}, {business} wasn't in Google's top 3 anywhere"],
  ["maps_rarely_found", "When I searched \"{trade}\" around {town}, {business} only showed up in a few spots"],
  ["not_mobile", "Your website is hard to use on a phone, which is where most people search"],
  ["not_secure", "Chrome marks your website as \"Not secure\""],
  ["very_slow", "Your website takes a while to load on a phone"],
  ["no_title", "Google isn't being told clearly that you're a {trade} in {town}"],
  ["title_no_trade", "Google isn't being told clearly that you're a {trade} in {town}"],
  ["title_no_town", "Google isn't being told clearly that you're a {trade} in {town}"],
  ["slow", "Your website takes a while to load on a phone"],
  ["no_form", "There's no quick way to ask for a quote on your website"],
];

/** The single most useful problem to mention, as a sentence (no full stop), or "". */
export function topProblem(findings = []) {
  const hit = PROBLEMS.find(([key]) => findings.includes(key));
  return hit ? hit[1] : "";
}

/**
 * Everything a template can use for one lead. extra: { competitor: {name, top3_pct}, spots: grid points, sender: {first} }.
 * Missing facts are left out, so versions that need them are skipped for this lead.
 */
export function facts(lead, extra = {}) {
  const business = cleanBusiness(lead.name);
  const town = titleCase(lead.town || lead.search_town || "");
  const trade = String(lead.trade || "").toLowerCase();
  const f = { business, town, trade, greeting: lead.director_first_name ? `Hi ${titleCase(lead.director_first_name)},` : "Hi," };
  const problem = topProblem(lead.findings || lead.audit?.findings || []);
  if (problem) f.problem = fill(problem, f);
  const m = lead.map_rank || lead.audit?.map_rank || {};
  if (m.top3_pct !== undefined && m.top3_pct !== null) f.top3 = String(Math.round(m.top3_pct));
  const c = extra.competitor;
  if (c?.name && f.top3 !== undefined && c.top3_pct > Number(f.top3)) {
    f.competitor = cleanBusiness(c.name);
    f.competitor_top3 = String(Math.round(c.top3_pct));
  }
  if (extra.spots) f.spots = String(extra.spots);
  if (lead.rating) f.rating = String(lead.rating);
  if (lead.review_count) f.reviews = String(lead.review_count);
  if (extra.sender?.first) f.sender_first = extra.sender.first;
  return f;
}

export const PLACEHOLDERS = ["greeting", "business", "town", "trade", "problem", "top3", "competitor", "competitor_top3", "spots", "rating", "reviews", "sender_first"];

export const placeholdersIn = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

function fill(text, f) {
  return String(text).replace(/\{(\w+)\}/g, (all, k) => (f[k] !== undefined && f[k] !== "" ? f[k] : all));
}

/** Render a version for a lead, or null if the lead lacks something the version needs. */
export function render(version, f) {
  const needed = [...placeholdersIn(version.subject || ""), ...placeholdersIn(version.body)];
  if (needed.some((k) => f[k] === undefined || f[k] === "")) return null;
  return { subject: fill(version.subject || "", f), body: fill(version.body, f) };
}

/** The fixed footer: who is writing (law), where the data came from (UK GDPR), how to opt out. */
export function footer(sender = {}) {
  return [
    `${sender.name || "{sender_name}"}, trading as Aetos Websites, ${sender.address || "{sender_address}"}`,
    "How I got your details: aetoswebsites.com/privacy",
    "Reply \"no thanks\" and I won't email again.",
  ].join("\n");
}

// ---------------------------------------------------------------- the quality gate (§5)

const ROBOT = ["hope this email finds you", "hope this finds you", "hope you are well", "hope you're well", "reaching out",
  "i am writing to", "i'm writing to", "leverage", "synergy", "touch base", "circle back", "just following up",
  "just checking in", "per my last", "as per", "kindly", "do not hesitate", "don't hesitate"];
const HYPE = ["revolutionary", "skyrocket", "explode your", "game-changer", "game changer", "cutting-edge", "cutting edge",
  "world-class", "best-in-class", "10x", "unbeatable", "amazing results", "incredible", "massive results", "!!"];
const INSULT = ["outdated", "terrible", "awful", "ugly", "old-fashioned", "old fashioned", "rubbish", "crap", "sucks",
  "embarrassing", "amateur", "poor website", "bad website", "dated website"];
const UNTRUE_UNTIL_DEMOS = ["i've mocked", "i have mocked", "i've built", "i have built", "i've made you", "i've designed", "i've put together"];

const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const has = (text, list) => list.filter((p) => text.toLowerCase().includes(p));

/** Problems with one email (template or rendered). Empty array = passes. */
export function gate({ subject = "", body = "" }, step, opts = {}) {
  const issues = [];
  const max = STEPS.find((s) => s.step === step)?.maxWords || 60;
  const text = `${subject}\n${body}`;
  if (words(body) > max) issues.push(`Too long: ${words(body)} words (max ${max})`);
  const long = String(body).split(/(?<=[.!?])\s+|\n+/).find((s) => words(s) > 25);
  if (long) issues.push(`Sentence over 25 words: "${long.slice(0, 60)}…"`);
  for (const p of has(text, ROBOT)) issues.push(`Sounds robotic: "${p}"`);
  for (const p of has(text, HYPE)) issues.push(`Hype: "${p}"`);
  for (const p of has(text, INSULT)) issues.push(`Could read as an insult: "${p}"`);
  if (/\bSEO\b/i.test(text)) issues.push('Says "SEO": say "front page of Google"');
  if ((body.match(/\?/g) || []).length > 1) issues.push("More than one question: keep one ask");
  if (!opts.demosLive) for (const p of has(body, UNTRUE_UNTIL_DEMOS)) issues.push(`Claims work not done yet: "${p}"`);
  const unknown = placeholdersIn(text).filter((k) => !PLACEHOLDERS.includes(k));
  if (unknown.length) issues.push(`Unknown placeholder: {${unknown.join("}, {")}}`);
  if (step === 1) {
    if (/https?:\/\/|www\.|\.(com|co\.uk|uk|net|org)\b/i.test(body)) issues.push("First email can't contain links");
    if (/£\s?\d|\d+\s?(pounds|quid)/i.test(text)) issues.push("First email can't mention prices");
    if (/\bfree\b/i.test(text)) issues.push('First email can\'t say "free"');
    if (/guarantee/i.test(text)) issues.push("Guarantees only go where their terms can be linked, not in the first email");
    if (!subject.trim()) issues.push("Needs a subject");
  }
  if (subject) {
    if (words(subject) > 6) issues.push(`Subject too long: ${words(subject)} words (max 6)`);
    if (/^\s*(re|fwd?)\s*:/i.test(subject)) issues.push('Subject can\'t fake "Re:" or "Fwd:"');
    if (/\p{Extended_Pictographic}/u.test(subject)) issues.push("No emoji in the subject");
  }
  if (opts.rendered) {
    if (/\{\w+\}/.test(text)) issues.push("Has an empty placeholder");
    if (/\b(ltd|limited)\.?\s+(ltd|limited)\b/i.test(text)) issues.push('Says "Ltd Ltd"');
    const shout = text.match(/\b[A-Z]{4,}\b/g);
    if (shout) issues.push(`SHOUTING: ${[...new Set(shout)].slice(0, 3).join(", ")}`);
    if (step === 1 && opts.lead) {
      const first = body.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^hi\b/i.test(l)).slice(0, 2).join(" ").toLowerCase();
      const specifics = [opts.lead.business, opts.lead.town, opts.lead.trade].filter(Boolean).map((s) => s.toLowerCase());
      if (!specifics.some((s) => first.includes(s))) issues.push("No lead-specific fact in the first 2 lines");
    }
  } else if (/\p{Extended_Pictographic}/u.test(body)) {
    issues.push("No emoji");
  }
  if (/\b[A-Z]{4,}\b/.test(subject)) issues.push("No ALL CAPS in the subject");
  return [...new Set(issues)];
}

// ---------------------------------------------------------------- who may be emailed (§6)

const ALLOWED_COMPANY_TYPES = ["ltd", "llp", "plc", "scottish-partnership", "private-limited-guarant-nsc",
  "private-limited-guarant-nsc-limited-exemption", "private-limited-shares-section-30-exemption"];
const FREEMAIL = ["gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.co.uk", "live.com",
  "yahoo.com", "yahoo.co.uk", "btinternet.com", "btopenworld.com", "sky.com", "aol.com", "icloud.com", "me.com", "msn.com",
  "talktalk.net", "virginmedia.com", "ntlworld.com", "blueyonder.co.uk", "mail.com", "protonmail.com", "proton.me", "gmx.com", "gmx.co.uk"];

export const domainOf = (email) => String(email || "").split("@")[1]?.toLowerCase() || "";

/**
 * Can outreach email this lead? Returns { ok, reason }.
 * ctx: { suppressed: Set of emails/domains/company numbers, contacted: Set of place_ids, guessedAllowed: bool }
 */
export function eligibility(lead, ctx = {}) {
  const suppressed = ctx.suppressed || new Set();
  const company = lead.audit?.company || {};
  const email = String(lead.email || "").toLowerCase();
  if (lead.excluded) return { ok: false, reason: "Excluded lead" };
  if (ctx.contacted?.has(lead.place_id)) return { ok: false, reason: "Already in a sequence" };
  if ((lead.status || "new") !== "new") return { ok: false, reason: "Already contacted" };
  if (!email) return { ok: false, reason: "No email: call list" };
  if (!lead.company_number || !company.type) return { ok: false, reason: "Not a limited company (sole trader?): call list" };
  if (!ALLOWED_COMPANY_TYPES.includes(company.type)) return { ok: false, reason: `Company type "${company.type}" needs consent: call list` };
  if (!["postcode", "town"].includes(company.match_basis)) return { ok: false, reason: "Company match not confirmed by address: call list" };
  if (FREEMAIL.includes(domainOf(email))) return { ok: false, reason: "Personal webmail address: call list" };
  if (lead.audit?.email_source === "guessed" && !ctx.guessedAllowed) return { ok: false, reason: "Guessed address (not in the first 4 weeks)" };
  if ([email, domainOf(email), lead.company_number].some((v) => suppressed.has(String(v).toLowerCase()))) return { ok: false, reason: "Opted out" };
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------- the numbers per version (§2, §4)

const DAY = 86400000;

/**
 * Per-version stats for a test. sends: step-1 sends [{version_id, place_id, sent_at}] (status sent);
 * replies: [{place_id, received_at, cls}] where cls is the final class (owner's, else automatic).
 */
export function versionStats(versions, sends, replies, now = Date.now()) {
  const byLead = new Map();
  for (const r of replies) {
    if (!byLead.has(r.place_id)) byLead.set(r.place_id, []);
    byLead.get(r.place_id).push(r);
  }
  return versions.map((v) => {
    const mine = sends.filter((s) => s.version_id === v.id);
    let counted = 0;
    let positive = 0;
    let negative = 0;
    let complaints = 0;
    for (const s of mine) {
      const sent = Date.parse(s.sent_at);
      const rs = byLead.get(s.place_id) || [];
      const pos = rs.some((r) => POSITIVE.includes(r.cls) && Date.parse(r.received_at) - sent <= RULES.creditDays * DAY);
      if (pos || now - sent >= RULES.creditDays * DAY) counted++;
      if (pos) positive++;
      if (rs.some((r) => NEGATIVE.includes(r.cls))) negative++;
      if (rs.some((r) => r.cls === "complaint")) complaints++;
    }
    const alpha = (v.prior_a ?? RULES.priorA) + positive;
    const beta = (v.prior_b ?? RULES.priorB) + (counted - positive);
    return { id: v.id, status: v.status, sends: mine.length, counted, positive, negative, complaints, alpha, beta, mean: alpha / (alpha + beta) };
  });
}

/** Add each live version's chance of being the best. */
export function withChances(stats, rng = Math.random) {
  const live = stats.filter((s) => s.status === "live");
  const p = probBest(live, 2000, rng);
  return stats.map((s) => ({ ...s, pbest: s.status === "live" ? p[live.indexOf(s)] : null }));
}

/** Which live version the next new lead gets (Thompson sampling with the exploration floor). */
export function chooseVersion(stats, rng = Math.random) {
  const live = stats.filter((s) => s.status === "live");
  if (!live.length) return null;
  const young = live.filter((s) => s.counted < RULES.floorUntil);
  if (young.length === live.length || (young.length && rng() < Math.min(1, RULES.floorShare * young.length))) {
    return young[Math.floor(rng() * young.length)].id;
  }
  return live[thompsonPick(live, rng)].id;
}

/**
 * What should happen to the test now. Returns a list of actions:
 * {type: "pause", id, reason} · {type: "retire", id, reason} · {type: "end", keep, reason}
 */
export function decide(test, stats, now = Date.now()) {
  const actions = [];
  for (const s of stats.filter((x) => x.status === "live")) {
    if (s.complaints > 0) actions.push({ type: "pause", id: s.id, reason: "Spam complaint: check the wording" });
    else if (s.sends >= RULES.guardMinSends && s.negative >= RULES.guardMinNegatives && s.negative / s.sends > RULES.guardRate) {
      actions.push({ type: "pause", id: s.id, reason: `${s.negative} negative replies or opt-outs in ${s.sends} emails` });
    }
  }
  const paused = new Set(actions.map((a) => a.id));
  let live = stats.filter((s) => s.status === "live" && !paused.has(s.id));
  for (const s of live) {
    if (live.length > 1 && s.counted >= RULES.decideAt && s.pbest !== null && s.pbest < RULES.retireBelow) {
      actions.push({ type: "retire", id: s.id, reason: `Under ${RULES.retireBelow * 100}% chance of being best after ${s.counted} emails` });
    }
  }
  const retired = new Set(actions.filter((a) => a.type === "retire").map((a) => a.id));
  live = live.filter((s) => !retired.has(s.id));
  if (!live.length || !test) return actions;
  const ageDays = (now - Date.parse(test.started_at)) / DAY;
  const everyoneDone = live.every((s) => s.counted >= RULES.decideAt);
  // a paused version may come back, so it keeps the test open; a retired one doesn't
  const anyPaused = paused.size > 0 || stats.some((s) => s.status === "paused");
  const lastStanding = live.length === 1 && !anyPaused && stats.some((s) => s.status === "retired" || retired.has(s.id));
  if (live.length > 1 && !anyPaused && (everyoneDone || ageDays >= RULES.maxTestDays)) {
    const keep = [...live].sort((a, b) => b.mean - a.mean)[0];
    actions.push({ type: "end", keep: keep.id, reason: everyoneDone ? `Every version reached ${RULES.decideAt} counted emails` : "8 weeks are up" });
  } else if (lastStanding) {
    actions.push({ type: "end", keep: live[0].id, reason: "Only one version left" });
  }
  return actions;
}
