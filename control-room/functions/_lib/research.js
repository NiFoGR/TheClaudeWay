// AI lead research (Claude on the owner's subscription, via a Routine): merging what Claude found into a lead.
// Pure function, tested. Claude must give a source URL for every email and the owner's name, so nothing is made up.

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const JUNK = /(example|sentry|wixpress|yourdomain|domain\.com|email\.com|noreply|no-reply)/i;
const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ""));
const clip = (s, n) => String(s || "").trim().slice(0, n);
const domainOf = (e) => String(e).split("@")[1]?.toLowerCase() || "";
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** Check and tidy what Claude sent. Returns { error } or { clean }. */
export function cleanResearch(body) {
  const emails = [];
  for (const e of Array.isArray(body.emails) ? body.emails.slice(0, 10) : []) {
    const email = clip(e?.email, 120).toLowerCase();
    if (!EMAIL.test(email) || JUNK.test(email)) continue;
    if (!isUrl(e?.source_url)) return { error: `Email ${email} needs the source_url where it was found` };
    if (!emails.some((x) => x.email === email)) emails.push({ email, source_url: clip(e.source_url, 400), where: clip(e.where, 80) });
  }
  let owner = null;
  if (body.owner?.first) {
    if (!isUrl(body.owner.source_url)) return { error: "The owner's name needs the source_url where it was found" };
    owner = { first: clip(body.owner.first, 30), full: clip(body.owner.full || body.owner.first, 60), source_url: clip(body.owner.source_url, 400) };
  }
  const socials = {};
  for (const [k, v] of Object.entries(body.socials || {})) if (isUrl(v)) socials[clip(k, 20).toLowerCase()] = clip(v, 400);
  const review = body.review && typeof body.review === "object" ? {
    verdict: clip(body.review.verdict, 40),
    summary: clip(body.review.summary, 600),
    problems: (body.review.problems || []).slice(0, 8).map((p) => clip(p, 200)).filter(Boolean),
    good: (body.review.good || []).slice(0, 5).map((p) => clip(p, 200)).filter(Boolean),
  } : null;
  const best = clip(body.best_email, 120).toLowerCase();
  const score = body.website_score;
  if (score != null && !(Number.isInteger(score) && score >= 0 && score <= 45)) return { error: "website_score must be a whole number from 0 to 45" };
  return {
    clean: {
      emails, owner, socials, review,
      best_email: EMAIL.test(best) ? best : "",
      best_email_why: clip(body.best_email_why, 200),
      website_score: score ?? null,
      score_reason: clip(body.score_reason, 300),
      too_big: body.too_big === true,
      too_big_reason: clip(body.too_big_reason, 200),
      wrong_findings: (body.wrong_findings || []).slice(0, 10).map((p) => clip(p, 300)).filter(Boolean),
      website: isUrl(body.website) ? clip(body.website, 300) : "",
      notes: clip(body.notes, 800),
      searched: (body.searched || []).slice(0, 15).map((s) => clip(s, 200)),
    },
  };
}

/** Merge Claude's findings into a lead row (already parsed by leadRow). Returns the columns to update. */
export function mergeResearch(lead, r, now = new Date().toISOString()) {
  const audit = { ...(lead.audit || {}) };
  const emails = [...(lead.emails || [])];
  const site = hostOf(lead.website || r.website);
  // emails Claude found (with proof) go first; on the business's own domain first of all
  const found = [...r.emails].sort((a, b) => (domainOf(b.email) === site) - (domainOf(a.email) === site));
  for (const e of [...found].reverse()) {
    const i = emails.indexOf(e.email);
    if (i >= 0) emails.splice(i, 1);
    emails.unshift(e.email);
  }
  let email = lead.email || "";
  const guessed = audit.email_source === "guessed";
  if (found.length && (!email || guessed)) {
    email = found[0].email;
    audit.email_source = "ai";
  }
  // Claude's pick of the address that reaches the decision maker (must be one we actually have)
  if (r.best_email && emails.includes(r.best_email) && r.best_email !== email) {
    email = r.best_email;
    audit.email_choice = "ai";
    if (found.some((e) => e.email === email)) audit.email_source = "ai";
  }
  if (email) emails.splice(0, emails.length, email, ...emails.filter((e) => e !== email));
  let first = lead.director_first_name || "";
  let full = lead.director_name || "";
  const weakOwner = !first || ["email", "business name", "Companies House"].includes(audit.owner_source);
  if (r.owner && weakOwner) {
    first = r.owner.first;
    full = r.owner.full;
    audit.owner_source = "AI research";
  }
  audit.ai_research = { ...r, done_at: now };
  audit.ai_needs = [];
  // Claude's rating of the website replaces the automated Website part of the score (Local SEO and Maps stay measured)
  let quality = lead.quality_score || 0;
  if (r.website_score != null) {
    const parts = { ...(audit.score || {}) };
    parts.website = r.website_score;
    parts.website_by = "claude";
    parts.total = Math.min(100, parts.website + (parts.seo || 0) + (parts.maps || 0));
    audit.score = parts;
    quality = parts.total;
  }
  const wrong = new Set(r.wrong_findings);
  const issues = (lead.issues || []).filter((i) => !wrong.has(i));
  const excluded = r.too_big ? 1 : lead.excluded ? 1 : 0;
  const reason = r.too_big ? `Too big for us (Claude: ${r.too_big_reason || "not owner-operated"})` : lead.exclude_reason || "";
  return {
    quality_score: quality,
    issues,
    excluded,
    exclude_reason: reason,
    email,
    emails,
    socials: { ...(lead.socials || {}), ...r.socials },
    director_first_name: first,
    director_name: full,
    audit,
  };
}
