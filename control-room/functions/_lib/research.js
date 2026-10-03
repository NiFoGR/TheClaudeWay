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
  return {
    clean: {
      emails, owner, socials, review,
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
  let first = lead.director_first_name || "";
  let full = lead.director_name || "";
  const weakOwner = !first || ["email", "business name", "Companies House"].includes(audit.owner_source);
  if (r.owner && weakOwner) {
    first = r.owner.first;
    full = r.owner.full;
    audit.owner_source = "AI research";
  }
  audit.ai_research = { ...r, done_at: now };
  return {
    email,
    emails,
    socials: { ...(lead.socials || {}), ...r.socials },
    director_first_name: first,
    director_name: full,
    audit,
  };
}
