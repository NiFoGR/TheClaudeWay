// Claude's research for one lead (stage 2, 03-research-grade.md): what the research Routine posts to
// POST /api/agent/research/:place_id, checked strictly. Pure, tested (tests/research.test.mjs).
// Every problem is listed at once, so Claude fixes them all in one retry. Nothing is ignored silently: an unknown field
// is an error, and Claude never sends a grade (grade.js computes it from the four points).
//
// Also pure, below validateResearch (tests/research-health.test.mjs): the notes merge that keeps Nik's lines, the
// parsed research row every later stage reads, the email hit rate and the research health light.
import { parseJson } from "./util.js";

/** The top-level fields of a research post, in Part A order (the Routine prompt's JSON has exactly these). */
export const RESEARCH_FIELDS = ["points", "reasons", "grade_reason", "angle", "opener", "owner", "emails", "best_email",
  "best_email_why", "copy", "site_review", "too_big", "notes", "searched"];
const OPTIONAL = new Set(["best_email_why", "notes"]);
const POINT_KEYS = ["need", "means", "reach", "fit"];
const ANGLE_KEYS = ["fact", "source_url"];
const OWNER_KEYS = ["first", "full", "source_url", "confident"];
const EMAIL_KEYS = ["email", "source_url", "where"];
const COPY_KEYS = ["headline", "intro", "services", "areas", "about"];
const REVIEW_KEYS = ["verdict", "summary", "problems", "good"];

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const JUNK = /(example|sentry|wixpress|yourdomain|domain\.com|email\.com|noreply|no-reply)/i;
const HTTP = /^https?:\/\/\S+$/i;
// A source address is a page Nik can open; 2,000 characters is far longer than any real one.
const URL_MAX = 2000;
// A first name: letters (accents included, however they're encoded), ' and -, with at least one letter, so an email
// never says "Hi -,".
const FIRST_NAME = /^(?=.*\p{L})[\p{L}\p{M}'’-]{1,30}$/u;
// Items checked one by one in any list; a longer list already fails its count rule, and this keeps a runaway post
// from costing CPU or a reply with thousands of problems.
const ITEMS_CHECKED = 50;
// What the opener and the demo copy must never carry: links, prices, the word SEO.
const SALESY = /http|www\.|£|\bseo\b/i;
const SALESY_MSG = "must not contain links, prices or the word SEO";
const OWNER_IN_NAME = `Owner's first name is also in the business name, so emails say "Hi," until Nik confirms it.`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const chars = (s) => [...s].length;
const fold = (s) => String(s || "").normalize("NFC").trim().toLowerCase().replace(/’/g, "'");

// The words of a business name, so "Dave" is found in "Dave's Plumbing" and "Anne" in "Mary-Anne Cleaning".
function nameWords(name) {
  const out = new Set();
  for (const w of fold(name).split(/[^\p{L}\p{M}'-]+/u)) {
    out.add(w);
    out.add(w.replace(/'s?$/, ""));
    for (const part of w.split("-")) out.add(part);
  }
  out.delete("");
  return out;
}

/**
 * Check Claude's research post for one lead. `lead` = {name, town, search_town} from the leads row.
 * Returns {errors: string[]} (every problem, Part A rules 1–11) or {clean, warnings: string[]}: `clean` has the Part A
 * shape (keys in RESEARCH_FIELDS order), text trimmed, emails and best_email lower-cased with duplicates merged, and
 * owner.confident forced false when the owner's first name is a word of the business name.
 */
export function validateResearch(body, lead = {}) {
  if (!isObj(body)) return { errors: ["Body must be a JSON object."] };
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  const has = (key) => Object.hasOwn(body, key);
  const unknown = (obj, allowed, prefix) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`Unknown field "${prefix}${k}". Allowed: ${allowed.join(", ")}`);
  };
  // Trimmed text of min..max characters, else an error and null. min 0 allows "".
  const text = (v, path, max, min = 1) => {
    const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : null;
    if (s !== null && chars(s) >= min && chars(s) <= max) return s;
    fail(min ? `${path} must be 1 to ${max} characters` : `${path} must be at most ${max} characters ("" if none)`);
    return null;
  };
  const url = (v, message) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (HTTP.test(s) && s.length <= URL_MAX) return s;
    fail(HTTP.test(s) ? `${message} (at most ${URL_MAX} characters)` : message);
    return null;
  };
  // A list of min..max strings, each 1..itemMax characters.
  const texts = (v, path, min, max, itemMax, countMessage) => {
    if (!Array.isArray(v)) {
      fail(countMessage);
      return null;
    }
    if (v.length < min || v.length > max) fail(countMessage);
    return v.slice(0, ITEMS_CHECKED).map((item, i) => text(item, `${path}[${i}]`, itemMax));
  };

  // 1. Only the known fields; all but best_email_why and notes required.
  unknown(body, RESEARCH_FIELDS, "");
  for (const k of RESEARCH_FIELDS) if (!OPTIONAL.has(k) && !has(k)) fail(`Missing field "${k}"`);

  // 11 (first, as angle, opener and copy depend on it). too_big is a boolean.
  let tooBig = false;
  if (has("too_big")) {
    if (typeof body.too_big === "boolean") tooBig = body.too_big;
    else fail("too_big must be true or false");
  }

  // 2. Four whole-number points 0–5, a reason for each.
  const points = {};
  if (has("points")) {
    if (!isObj(body.points)) fail("points must be {need, means, reach, fit}, each a whole number from 0 to 5");
    else {
      unknown(body.points, POINT_KEYS, "points.");
      for (const k of POINT_KEYS) {
        const v = body.points[k];
        if (Number.isInteger(v) && v >= 0 && v <= 5) points[k] = v;
        else fail(`points.${k} must be a whole number from 0 to 5`);
      }
    }
  }
  const reasons = {};
  if (has("reasons")) {
    if (!isObj(body.reasons)) fail("reasons must be {need, means, reach, fit}, each a one-line reason of 1 to 160 characters");
    else {
      unknown(body.reasons, POINT_KEYS, "reasons.");
      for (const k of POINT_KEYS) reasons[k] = text(body.reasons[k], `reasons.${k}`, 160);
    }
  }
  const grade_reason = has("grade_reason") ? text(body.grade_reason, "grade_reason", 300) : null;

  // 7. Angle: 1–3 facts (0–3 when too big), each with the http(s) page it can be seen on.
  let angle = null;
  if (has("angle")) {
    const a = body.angle;
    const min = tooBig ? 0 : 1;
    if (!Array.isArray(a) || a.length < min || a.length > 3) {
      fail(tooBig ? "angle must list at most 3 facts, each with its source_url" : "angle must list 1 to 3 facts, each with its source_url");
    }
    if (Array.isArray(a)) {
      angle = a.slice(0, ITEMS_CHECKED).map((item, i) => {
        if (!isObj(item)) {
          fail(`angle[${i}] must be {fact, source_url}`);
          return null;
        }
        unknown(item, ANGLE_KEYS, `angle[${i}].`);
        return {
          fact: text(item.fact, `angle[${i}].fact`, 200),
          source_url: url(item.source_url, `angle[${i}].source_url must be the http(s) address of the page where the fact can be seen`),
        };
      });
    }
  }

  // 8. Opener: 1–300 characters ("" only when too big), two lines at most, no links, prices or SEO.
  let opener = null;
  if (has("opener")) {
    const o = typeof body.opener === "string" ? body.opener.replace(/\r\n?/g, "\n").trim() : null;
    if (o === null || chars(o) > 300 || (!o && !tooBig)) {
      fail(tooBig ? "opener must be at most 300 characters" : "opener must be 1 to 300 characters");
    }
    if (o !== null) {
      if ((o.match(/\n/g) || []).length > 1) fail("opener must be two lines at most (one line break)");
      if (SALESY.test(o)) fail(`opener ${SALESY_MSG}`);
      opener = o;
    }
  }

  // 6. Owner: null, or a first name (never the town; a word of the business name makes it not confident) with its source.
  let owner = null;
  if (has("owner") && body.owner !== null) {
    const w = body.owner;
    if (!isObj(w)) fail("owner must be {first, full, source_url, confident}, or null when you don't know who runs it");
    else {
      unknown(w, OWNER_KEYS, "owner.");
      const first = typeof w.first === "string" ? w.first.normalize("NFC").trim() : "";
      const named = FIRST_NAME.test(first);
      if (!named) fail("owner.first must be their first name only: 1 to 30 letters (' and - allowed, at least one letter)");
      const isTown = !!first && [lead?.town, lead?.search_town].some((t) => t && fold(t) === fold(first));
      if (isTown) fail(`"${first}" is the town, not a person`);
      const full = text(w.full, "owner.full", 60);
      const source_url = url(w.source_url, "owner.source_url must be the http(s) address of the page that shows who runs it");
      if (typeof w.confident !== "boolean") fail("owner.confident must be true or false");
      let confident = w.confident === true;
      if (named && !isTown && nameWords(lead?.name).has(fold(first))) {
        confident = false;
        warnings.push(OWNER_IN_NAME);
      }
      owner = { first, full, source_url, confident };
    }
  }

  // 3. Emails: real addresses, each with the http(s) page it was seen on and where; duplicates merged; 10 at most.
  const emails = [];
  let listed = null; // every address listed, normalised (best_email and reach are checked against these)
  let found = false; // anything listed at all, even a malformed entry (so one bad entry isn't also "no email found")
  if (has("emails")) {
    if (!Array.isArray(body.emails)) fail("emails must be a list of {email, source_url, where} ([] when you found none)");
    else {
      listed = [];
      found = body.emails.length > 0;
      const kept = new Set();
      body.emails.slice(0, ITEMS_CHECKED).forEach((e, i) => {
        if (!isObj(e)) {
          if (typeof e === "string") listed.push(e.trim().toLowerCase()); // a bare address is still listed
          fail(`emails[${i}] must be {email, source_url, where}`);
          return;
        }
        unknown(e, EMAIL_KEYS, `emails[${i}].`);
        const email = typeof e.email === "string" ? e.email.trim().toLowerCase() : "";
        listed.push(email);
        const real = EMAIL.test(email) && !JUNK.test(email);
        if (!EMAIL.test(email)) fail(`Email "${email}" is not a valid email address`);
        else if (!real) fail(`Email "${email}" is a placeholder or system address, not a real inbox: leave it out`);
        const source_url = url(e.source_url, `Email ${email || `emails[${i}]`} needs the http(s) source_url of the page you saw it on`);
        const where = text(e.where, `emails[${i}].where`, 80);
        if (real && source_url && where !== null && !kept.has(email)) {
          kept.add(email);
          emails.push({ email, source_url, where });
        }
      });
      if (body.emails.length > ITEMS_CHECKED || new Set(listed).size > 10) fail("emails must list at most 10 addresses");
    }
  }

  // 4. best_email: one of the emails (normalised the same way); null only when there are none.
  let best_email = null;
  if (has("best_email") && listed) {
    const b = body.best_email;
    const s = typeof b === "string" ? b.trim().toLowerCase() : null;
    if (!found) {
      if (b !== null) fail("best_email must be null when no email was found");
    } else if (s === null || !listed.includes(s)) fail("best_email must be one of the emails you listed");
    else best_email = s;
  }
  let best_email_why = null;
  if (has("best_email_why") && body.best_email_why !== null && !(typeof body.best_email_why === "string" && !body.best_email_why.trim())) {
    best_email_why = text(body.best_email_why, "best_email_why", 200);
  }

  // 5. Reach matches the emails: none found ⇔ reach 0; reach 5 is the owner's own email, so the owner is named.
  if (Number.isInteger(points.reach) && listed) {
    if (!found && points.reach !== 0) fail("reach must be 0 when no email was found");
    if (found && points.reach === 0) fail("reach 0 means no email, but you listed some");
  }
  if (points.reach === 5 && has("owner") && body.owner === null) fail("reach 5 means the owner's own email: say who the owner is");

  // 9. Copy for their demo site: needed unless too big or fit 0–1; no links, prices or SEO anywhere in it.
  let copy = null;
  if (has("copy")) {
    const c = body.copy;
    const optional = tooBig || (Number.isInteger(points.fit) && points.fit <= 1);
    if (c === null) {
      if (!optional) fail("copy is needed for their demo site (null only when too_big is true or fit is 0 or 1)");
    } else if (!isObj(c)) fail("copy must be {headline, intro, services, areas, about}, or null");
    else {
      unknown(c, COPY_KEYS, "copy.");
      copy = {
        headline: text(c.headline, "copy.headline", 70),
        intro: text(c.intro, "copy.intro", 300),
        services: texts(c.services, "copy.services", 0, 8, 40, "copy.services must list at most 8 services"),
        areas: texts(c.areas, "copy.areas", 1, 12, 40, "copy.areas must list 1 to 12 areas (just their town if they don't say)"),
        about: text(c.about, "copy.about", 600, 0),
      };
      for (const k of COPY_KEYS) {
        const v = c[k];
        const words = Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : typeof v === "string" ? v : "";
        if (SALESY.test(words)) fail(`copy.${k} ${SALESY_MSG}`);
      }
    }
  }

  // 10. Site review: null (their website wasn't opened) or the object with the table's lengths.
  let site_review = null;
  if (has("site_review") && body.site_review !== null) {
    const r = body.site_review;
    if (!isObj(r)) fail("site_review must be {verdict, summary, problems, good}, or null when you didn't open their website");
    else {
      unknown(r, REVIEW_KEYS, "site_review.");
      site_review = {
        verdict: text(r.verdict, "site_review.verdict", 40),
        summary: text(r.summary, "site_review.summary", 400),
        problems: texts(r.problems, "site_review.problems", 0, 6, 200, "site_review.problems must list at most 6 problems"),
        good: texts(r.good, "site_review.good", 0, 4, 200, "site_review.good must list at most 4 things"),
      };
    }
  }

  // 11. Notes ≤ 800 (never a line that passes for one of Nik's); searched 3–30 entries.
  let notes = "";
  if (has("notes") && body.notes !== null) {
    notes = text(body.notes, "notes", 800, 0) ?? "";
    if (/^\s*\[Nik /m.test(notes)) fail(`notes must not contain lines starting "[Nik ": those are Nik's own notes`);
  }
  let searched = null;
  if (has("searched")) {
    const s = body.searched;
    if (!Array.isArray(s) || s.length < 3) fail("searched must list at least 3 things you searched or opened");
    else if (s.length > 30) fail("searched must list at most 30 things");
    if (Array.isArray(s)) searched = s.slice(0, ITEMS_CHECKED).map((item, i) => text(item, `searched[${i}]`, 200));
  }

  if (errors.length) return { errors };
  return {
    clean: {
      points, reasons, grade_reason, angle, opener, owner, emails, best_email, best_email_why, copy, site_review,
      too_big: tooBig, notes, searched,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- notes, the parsed row, the health light (Task 3)

// One of Nik's note lines, "[Nik YYYY-MM-DD] …": written on top of notes by "Research is wrong" and stage 3's "Not a
// fit", and kept forever. Claude's notes and the server's warnings below them are replaced on every post. The same
// test as validateResearch's, which never lets Claude write a line that passes for one of these.
const NIK_LINE = /^\s*\[Nik /;
const NIK_PREFIX = /^\s*\[Nik ([^\]]*)\]\s*/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const noteLines = (s) => (typeof s === "string" ? s.replace(/\r\n?/g, "\n").split("\n") : []);

/**
 * The notes to store after a post: every line of `oldNotes` starting "[Nik " (in order) on top, then Claude's notes,
 * then the `extra` lines (the server's warnings). Claude's old notes and old warnings are dropped. A line of Claude's
 * that passes for one of Nik's is left out (validateResearch already rejects it), so it can never be kept as his.
 */
export function mergeNotes(oldNotes, claudeNotes, extra = []) {
  const nik = noteLines(oldNotes).filter((line) => NIK_LINE.test(line)).map((line) => line.trim());
  const claude = noteLines(claudeNotes).filter((line) => !NIK_LINE.test(line)).join("\n").trim();
  const warnings = (Array.isArray(extra) ? extra : []).filter((s) => typeof s === "string").map((s) => s.trim());
  return [...nik, claude, ...warnings].filter(Boolean).join("\n");
}

/**
 * The text of Nik's newest note line, without its "[Nik YYYY-MM-DD] " prefix, or null when there's none. Newest = the
 * latest date; on the same day the line higher up (every writer puts the new line on top).
 */
export function latestNikNote(notes) {
  let newest = null;
  for (const line of noteLines(notes)) {
    const m = NIK_PREFIX.exec(line);
    const text = m ? line.slice(m[0].length).trim() : "";
    if (!text) continue;
    const day = ISO_DAY.test(m[1]) ? m[1] : "";
    if (!newest || day > newest.day) newest = { day, text };
  }
  return newest ? newest.text : null;
}

// The research row's JSON columns: objects (null when missing or unreadable) and lists ([] when missing or unreadable).
const OBJECT_COLUMNS = ["points", "owner", "copy", "site_review"];
const LIST_COLUMNS = ["angle", "emails", "searched"];
const tooBigOf = (v) => !!Number(v); // 0/1 as D1 gives it (true/false accepted)

/**
 * A `research` row as every reader uses it (stages 3–5 read this, never the raw JSON): points, owner, copy and
 * site_review as objects or null; angle, emails and searched as lists; too_big a boolean; notes a string. A JSON column
 * that can't be read, or holds the wrong shape, gives its fallback, never a throw. null (no row) gives null.
 */
export function parseResearch(row) {
  if (!isObj(row)) return null;
  const out = { ...row };
  const read = (value, fallback) => (typeof value === "string" ? parseJson(value, fallback) : value ?? fallback);
  for (const c of OBJECT_COLUMNS) {
    const v = read(row[c], null);
    out[c] = isObj(v) ? v : null;
  }
  for (const c of LIST_COLUMNS) {
    const v = read(row[c], []);
    out[c] = Array.isArray(v) ? v : [];
  }
  out.too_big = tooBigOf(row.too_big);
  out.notes = typeof row.notes === "string" ? row.notes : "";
  return out;
}

/**
 * How often Claude found an email: rows [{best_email, too_big}], too-big rows left out (they're never emailed).
 * {hits: rows with a best_email, n: rows judged, pct: whole-number percent, null when n is 0}.
 */
export function emailHitRate(rows) {
  const judged = (Array.isArray(rows) ? rows : []).filter((r) => isObj(r) && !tooBigOf(r.too_big));
  const hits = judged.filter((r) => typeof r.best_email === "string" && r.best_email.trim() !== "").length;
  const n = judged.length;
  return { hits, n, pct: n ? Math.round((hits * 100) / n) : null };
}

const HOUR_MS = 3_600_000;
const STALL_HOURS = 26; // the Routine runs every morning, so a day and a bit without a post means it has stopped
const RECENT_ROWS = 20;
const MIN_JUDGED = 10;
const HIT_TARGET = 40;
const RESEARCH_RED_FIX = `Open claude.ai/code/routines, check "aetos-research" is on and its last run finished, then press Run now.`;
const RESEARCH_AMBER_FIX = `Open a few on the Leads page and press "Research is wrong" where Claude missed an email.`;

// A time (a Date, ISO text or ms) in ms, or null when there's none or it can't be read.
function msOf(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The research health light (registered with stage 0's registerLight by research-db.js). facts = {queued: rows
 * waiting, lastPostAt: newest researched_at, oldestQueuedAt: oldest queued_at, recent: the last 20 done rows
 * [{best_email, too_big}], newest first}. Never grey.
 * - red: leads are waiting and nothing has been posted for 26 h: since the last post, or since the oldest lead was
 *   queued if nothing was ever posted. A lead queued after quiet days (nothing to research, or Nik's re-check) has to
 *   have waited the 26 h too, so a Routine that ran with nothing to do isn't called stopped.
 * - amber: at least 10 of the last 20 done rows aren't too big, and fewer than 40% of those found an email.
 * - green otherwise, with what's known: "<n> waiting · last research <h> h ago · emails found <pct>%".
 */
export function researchLight(facts, now = new Date()) {
  const at = msOf(now);
  if (at === null) throw new TypeError("The research light needs the time now, as a Date or an ISO time.");
  const name = "research";
  const f = isObj(facts) ? facts : {};
  const queued = Math.max(0, Math.floor(Number(f.queued) || 0));
  const posted = msOf(f.lastPostAt);
  const oldest = msOf(f.oldestQueuedAt);
  const hoursSince = (ms) => Math.floor(Math.max(0, at - ms) / HOUR_MS);

  const since = posted ?? oldest;
  const waitingSince = posted !== null && oldest !== null ? Math.max(posted, oldest) : since;
  if (queued > 0 && since !== null && at - waitingSince >= STALL_HOURS * HOUR_MS) {
    const leads = queued === 1 ? "1 lead" : `${queued} leads`;
    return { name, level: "red", detail: `No research posted for ${hoursSince(since)} hours; ${leads} waiting.`, fix: RESEARCH_RED_FIX };
  }

  const rate = emailHitRate(Array.isArray(f.recent) ? f.recent.slice(0, RECENT_ROWS) : []);
  if (rate.n >= MIN_JUDGED && rate.pct < HIT_TARGET) {
    return {
      name, level: "amber",
      detail: `Emails found for ${rate.hits} of the last ${rate.n} researched (${rate.pct}%); target 40%+.`,
      fix: RESEARCH_AMBER_FIX,
    };
  }

  const parts = [`${queued} waiting`];
  if (posted !== null) parts.push(`last research ${hoursSince(posted)} h ago`);
  if (rate.pct !== null) parts.push(`emails found ${rate.pct}%`);
  return { name, level: "green", detail: parts.join(" · "), fix: "" };
}
