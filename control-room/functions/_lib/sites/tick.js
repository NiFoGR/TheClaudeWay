// Tick step `sites` (stage 10, docs/rebuild/09-build.md sections 7, 12 and 14; Task 26), every 5 minutes:
//
// 1. DNS checks: at most 5 hosts a run, oldest check first (never-checked first). A host is checked at most every
//    15 minutes until the site is live, then once a day. Every site with a host that isn't offline is checked (the
//    domain work starts at Send, alongside the build), so host_check = {at, ok, detail, fails} is fresh on the Site
//    page. `fails` counts checks in a row that said the host doesn't point at us (the `sites` light turns red at 2
//    for a live site); a lookup that couldn't be made says so in `detail` and doesn't count as one. A nameservers-
//    mode domain whose NS answer is only *.ns.cloudflare.com ticks its `ns_wait` step and closes that todo.
// 2. Going live: an approved site (status live) whose check passes and that has been opened once on its host
//    (seen_at) gets the go-live email (to client_links.email, else the form's business.email), then markLive sets
//    live_at and the onboarding row, and every build:<client_id>: todo closes except `gbp`. The email has the message
//    id `go-live:<client_id>`, so a run that stopped between the two never emails twice; with no mailbox at all,
//    sendClientMail files setup:client-mail:<client_id>:go-live with the email as its draft. A site opened within 15
//    minutes of a passing check goes live on the next run from that check (no DNS lookup), not at the next check.
// 3. Todos: under 48 h left and not live → build:<client_id>:due naming the first thing missing (its title follows
//    when that changes); content not posted 3 h after the build Routine accepted a fire → build:<client_id>:stuck.
// 4. Chat leads: a chat with contact details, quiet for 10 minutes and not yet emailed, goes to the business through
//    notifyLead (no todo when there's no mailbox: it stays on the Site page and goes once a mailbox exists, if that's
//    within 30 days of the chat). At most 3 are emailed a run, from the 12 oldest, so a lead with no address to go
//    to (it stays un-emailed) can't hold up the others.
// 5. pruneHits: rate_hits windows older than 48 h.
//
// D1 budget: 1 select for the DNS candidates, then per site 1 write (+ 2 for ns_wait, + 8 to go live), 1 select for
// the todos (+ 1 each, + 1 to set aside a stuck todo Nik closed before the latest fire), 1 select for chat leads (+ 6 each), 1 prune. With ctx.budget, nothing is started that
// would leave fewer than 2 queries for the tick's own closing writes; what's left waits for the next run.
// Tested in control-room/tests/sites-tick.test.mjs.
import { sendClientMail } from "../client-mail.js";
import { addTodo, closeTodos } from "../todo.js";
import { ukParts } from "../ukTime.js";
import { iso, parseJson } from "../util.js";
import { chatEnabled } from "./chat.js";
import { goLiveEmail, oneLine } from "./copy.js";
import { countdown } from "./countdown.js";
import { markLive, updateDomain } from "./db.js";
import { HOST_CHECK_FAILED, checkHost, checkNs } from "./dns.js";
import { PAGES_PROJECT, domainMode } from "./domain.js";
import { onboardFirst } from "./form.js";
import "./health.js"; // registers the `sites` and `chat` health lights wherever the tick loads
import { notifyLead } from "./notify.js";
import { pruneHits } from "./rate.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DNS_PER_RUN = 5;
const RECHECK_MS = 15 * MIN_MS; // until live
const RECHECK_LIVE_MS = 24 * HOUR_MS; // once live
const DUE_SOON_HOURS = 48;
const STUCK_MS = 3 * HOUR_MS;
const CHAT_QUIET_MS = 10 * MIN_MS;
const LEADS_PER_RUN = 3;
const LEADS_LOOKED_AT = 12; // read per run, so leads with nowhere to go (no address) can't hold up the rest
const TODOS_PER_RUN = 6;
const RESERVE = 2; // left for the tick's closing writes (last runs + beat)
const FIRES_LOOKED_AT = 1000; // newest routine_fires rows read for the stuck rule (as sites/health.js does)
const NO_HOST = "Type the client's web address on the Site page first.";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// What one site costs in D1 queries.
const COST = { check: 1, ns: 2, goLive: 8, todo: 1, lead: 6 };

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const objectOf = (value) => {
  const v = typeof value === "string" ? parseJson(value, null) : value;
  return isObject(v) ? v : {};
};
const nameOf = (row) => oneLine(row?.name) || "This client";
const isDuplicateId = (err) => /UNIQUE constraint failed: messages\.id/.test(String(err?.message));

function toDate(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("The sites step needs the time now, as a Date or an ISO time.");
  return date;
}

// Room for `cost` more queries, keeping RESERVE for the tick. No budget (a direct call) means no limit.
const room = (budget, cost) => !budget || typeof budget.left !== "function" || budget.left() - cost >= RESERVE;

// Everything the DNS check, the go-live and its email need, per site, in one select. ?1 = the cutoff for sites not
// yet live (15 min), ?2 = for live ones (24 h), ?3 = the limit; a WHERE on the client id replaces the cutoffs for
// checkSite. Only whether the Workers AI secrets are set is read, never their values.
const siteSelect = (where) => `WITH s AS (
    SELECT cs.*, CASE WHEN json_valid(cs.host_check) THEN json_extract(cs.host_check, '$.at') END AS checked_at
    FROM client_sites cs)
  SELECT s.client_id, s.place_id, s.host, s.status, s.host_check, s.seen_at, s.is_test, s.features, s.review_url,
    s.domain, s.live_at, s.checked_at, c.name AS name, c.package AS package, c.cancelled_on AS cancelled_on,
    l.email AS link_email, o.form AS form,
    (SELECT p.greet_name FROM prospects p WHERE p.place_id = s.place_id) AS greet_name,
    (SELECT r.owner FROM research r WHERE r.place_id = s.place_id) AS research_owner,
    (SELECT v.value FROM settings v WHERE v.key = 'sites:pages_host') AS pages_host,
    (SELECT v.value FROM settings v WHERE v.key = 'offer:chatbot_live') AS chatbot_live,
    EXISTS (SELECT 1 FROM settings v WHERE v.key = 'secret:cf_ai:account_id' AND v.value <> '') AS has_account,
    EXISTS (SELECT 1 FROM settings v WHERE v.key = 'secret:cf_ai:token' AND v.value <> '') AS has_token
  FROM s
  LEFT JOIN clients c ON c.id = s.client_id
  LEFT JOIN client_links l ON l.client_id = s.client_id
  LEFT JOIN onboarding o ON o.client_id = s.client_id
  ${where}`;

// Also an approved site whose last check passed and that has just been opened (seen_at): it goes live on this run
// from that check, without waiting up to 15 minutes for the next one (no DNS lookup for it). Those come first, then
// approved sites still waiting to go live (the guarantee clock is on them), then the rest, oldest check first.
const READY_SQL = `(s.status = 'live' AND s.live_at IS NULL AND s.seen_at IS NOT NULL
    AND json_valid(s.host_check) AND json_extract(s.host_check, '$.ok') = 1)`;
const DUE_CHECKS_SQL = siteSelect(`WHERE s.status <> 'off' AND s.host IS NOT NULL
    AND (s.checked_at IS NULL OR s.checked_at <= CASE WHEN s.live_at IS NULL THEN ?1 ELSE ?2 END OR ${READY_SQL})
  ORDER BY NOT ${READY_SQL}, NOT (s.status = 'live' AND s.live_at IS NULL), s.checked_at IS NOT NULL, s.checked_at,
    s.client_id
  LIMIT ?3`);
const ONE_SITE_SQL = siteSelect("WHERE s.client_id = ?1");

/** The site row from siteSelect, with its JSON columns read. */
function readRow(r) {
  return { ...r, host_check: objectOf(r.host_check), domain: objectOf(r.domain), features: objectOf(r.features), form: objectOf(r.form) };
}

const pagesHostOf = (site) => oneLine(site.pages_host) || `${PAGES_PROJECT}.pages.dev`;
const goLiveReady = (site) => site.status === "live" && !site.live_at && Boolean(site.seen_at);
// The plan's mode as Send stored it, else worked out from the form's domain answers (the same rule Send uses).
const modeOf = (site) => (typeof site.domain.mode === "string" && site.domain.mode) || domainMode(site.form.domain);
const nsPending = (site) => modeOf(site) === "nameservers" && !objectOf(site.domain.steps).ns_wait;
const nsDomain = (site) => oneLine(site.domain.domain) || String(site.host ?? "").replace(/^www\./, "");

// The DNS check for one site: host_check stored, ns_wait ticked, and the site put live when it's ready.
// → {ok, detail, live}
async function checkOne(DB, site, at, fetchImpl) {
  const stamp = iso(at);
  const check = await checkHost(site.host, pagesHostOf(site), { fetchImpl });
  const before = Number(site.host_check.fails) || 0;
  const fails = check.ok ? 0 : check.detail === HOST_CHECK_FAILED ? before : before + 1;
  // Guarded on the host: one changed on the Site page while this ran gets its own check next time.
  await DB.prepare("UPDATE client_sites SET host_check = ? WHERE client_id = ? AND host = ?")
    .bind(JSON.stringify({ at: stamp, ok: check.ok, detail: check.detail, fails }), site.client_id, site.host)
    .run();

  if (nsPending(site) && nsDomain(site) && (await checkNs(nsDomain(site), { fetchImpl }))) {
    await updateDomain(DB, site.client_id, { steps: { ns_wait: stamp } }, at);
    await closeTodos(DB, `build:${site.client_id}:domain:ns_wait`);
  }

  const live = check.ok && goLiveReady(site) ? await goLive(DB, site, at) : false;
  return { ok: check.ok, detail: check.detail, live };
}

// The go-live email, then live_at. True when this call put the site live.
async function goLive(DB, site, at) {
  const id = site.client_id;
  const form = site.form;
  const to = [site.link_email, form.business?.email].map((v) => oneLine(v)).find(Boolean);
  if (to) {
    const chatOn = chatEnabled({
      site,
      settings: { "offer:chatbot_live": site.chatbot_live },
      secrets: { "cf_ai:account_id": Number(site.has_account) === 1, "cf_ai:token": Number(site.has_token) === 1 },
    }).on;
    const first = oneLine(site.greet_name) || onboardFirst({ owner: parseJson(site.research_owner, null) });
    const review = site.features.review_booster === false ? null : site.review_url;
    try {
      await sendClientMail(DB, {
        id: `go-live:${id}`,
        client_id: id,
        place_id: site.place_id ?? null,
        to,
        business: nameOf(site),
        now: at,
        compose: (nik) => goLiveEmail({
          first, host: site.host, leadsEmail: form.business?.leads_email, chatOn,
          fullPackage: site.package !== "website", reviewUrl: review, nik,
        }),
        noMailboxTodo: {
          dedupe: `setup:client-mail:${id}:go-live`,
          title: "Send {name} this email yourself (no mailbox yet)",
          link: `/#/site/${id}`,
        },
      });
    } catch (err) {
      if (!isDuplicateId(err)) throw err; // queued by an earlier run that stopped before markLive
    }
  } else {
    console.error(`Site ${id} went live with no email address for the go-live email.`);
  }
  if (!(await markLive(DB, id, at))) return false;
  await closeBuildTodos(DB, id);
  return true;
}

// Every open build:<client_id>: todo except build:<client_id>:gbp (closed by its own checkbox), freeing each dedupe
// as closeTodos does. One statement.
async function closeBuildTodos(DB, client_id) {
  const prefix = `build:${client_id}:`;
  const at = new Date().toISOString();
  await DB.prepare(
    `UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
     WHERE status = 'open' AND substr(dedupe, 1, length(?2)) = ?2 AND dedupe <> ?3`,
  )
    .bind(at, prefix, `${prefix}gbp`)
    .run();
}

/**
 * The Site page's Check now: the DNS check for one site, at once (whatever its last check), with the same ns_wait
 * tick and go-live as the tick step. → {ok, detail, live} | null when the client has no site.
 */
export async function checkSite(DB, client_id, { fetchImpl = fetch, now = new Date() } = {}) {
  const at = toDate(now);
  const row = await DB.prepare(ONE_SITE_SQL).bind(client_id).first();
  if (!row) return null;
  const site = readRow(row);
  if (!site.host) return { ok: false, detail: NO_HOST, live: false };
  return checkOne(DB, site, at, fetchImpl);
}

// --- todos ----------------------------------------------------------------------------------------------------------

// Every site that isn't offline, with its clock, its content, the last build/changes fire the Routine accepted and
// the due/stuck todos it already has. ?1 = how many of the newest routine_fires rows to read.
const TODO_FACTS_SQL = `WITH fires AS MATERIALIZED (
    SELECT reason, MAX(at) AS at FROM routine_fires
    WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM routine_fires) - ?1
      AND routine = 'build' AND error IS NULL
    GROUP BY reason)
  SELECT cs.client_id, cs.place_id, cs.status, cs.host, cs.host_check, cs.seen_at, cs.live_at, cs.content_at,
    cs.content IS NOT NULL AS has_content, c.name AS name, o.due_live_at AS due_live_at,
    (SELECT MAX(f.at) FROM fires f
       WHERE f.reason IN ('build: client ' || cs.client_id, 'changes: client ' || cs.client_id)) AS fired_at,
    (SELECT t.title FROM todos t WHERE t.dedupe = 'build:' || cs.client_id || ':due') AS due_title,
    (SELECT t.status FROM todos t WHERE t.dedupe = 'build:' || cs.client_id || ':due') AS due_status,
    (SELECT t.status FROM todos t WHERE t.dedupe = 'build:' || cs.client_id || ':stuck') AS stuck_status,
    (SELECT t.created_at FROM todos t WHERE t.dedupe = 'build:' || cs.client_id || ':stuck') AS stuck_created
  FROM client_sites cs
  LEFT JOIN clients c ON c.id = cs.client_id
  LEFT JOIN onboarding o ON o.client_id = cs.client_id
  WHERE cs.status <> 'off'
  ORDER BY o.due_live_at IS NULL, o.due_live_at, cs.client_id`;

/** What's keeping a site from going live, first one first (section 7's countdown). */
function missingFor(site) {
  if (Number(site.has_content) !== 1 || site.status === "draft") return "Claude hasn't built it";
  if (site.status !== "live") return "it needs your approval";
  if (!site.host || objectOf(site.host_check).ok !== true) return "the domain isn't connected";
  return "open the site once";
}

const ms = (v) => {
  const t = typeof v === "string" && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

async function todosFor(DB, at, budget) {
  const { results } = await DB.prepare(TODO_FACTS_SQL).bind(FIRES_LOOKED_AT).all();
  let due = 0, stuck = 0, written = 0;
  for (const site of results ?? []) {
    const id = site.client_id;
    const name = nameOf(site);
    const link = `/#/site/${id}`;

    // Due: under 48 h left (or past due), not live.
    if (!site.live_at && ms(site.due_live_at) !== null && countdown(site.due_live_at, null, at).hoursLeft < DUE_SOON_HOURS) {
      const day = DAYS[ukParts(new Date(site.due_live_at)).weekday];
      const title = `${name}'s site is due live ${day} and isn't live yet: ${missingFor(site)}`;
      const dedupe = `build:${id}:due`;
      if (site.due_status == null || (site.due_status === "open" && site.due_title !== title)) {
        if (written >= TODOS_PER_RUN || !room(budget, COST.todo)) break;
        written++;
        if (site.due_status == null) {
          const added = await addTodo(DB, {
            kind: "build", title, link, client_id: id, place_id: site.place_id ?? null, due_at: site.due_live_at, dedupe,
          });
          if (added) due++;
        } else {
          const r = await DB.prepare("UPDATE todos SET title = ? WHERE dedupe = ? AND status = 'open'").bind(title, dedupe).run();
          if (r.meta?.changes > 0) due++;
        }
      }
    }

    // Stuck: the Routine accepted a build or changes fire 3 h ago and no content has come since. One todo per fire:
    // an open one, or one Nik closed after this fire, stands; one he ticked or dismissed before it (Done and Dismiss
    // keep the dedupe) is set aside, or it would hold the dedupe and no later fire would ever get a todo.
    const fired = ms(site.fired_at);
    const contentAt = ms(site.content_at);
    const stale = site.stuck_status != null && site.stuck_status !== "open" && (ms(site.stuck_created) ?? 0) < (fired ?? 0);
    if (fired !== null && at.getTime() - fired >= STUCK_MS && (contentAt === null || contentAt < fired)
      && (site.stuck_status == null || stale)) {
      if (written >= TODOS_PER_RUN || !room(budget, COST.todo + (stale ? 1 : 0))) break;
      written++;
      if (stale) {
        await DB.prepare(
          `UPDATE todos SET dedupe = dedupe || '@' || COALESCE(done_at, created_at) WHERE dedupe = ? AND status <> 'open'`,
        ).bind(`build:${id}:stuck`).run();
      }
      const built = Number(site.has_content) === 1;
      const title = built
        ? `Claude hasn't made the changes to ${name}'s site yet: press Ask Claude for changes again on the Site page`
        : `Claude hasn't built ${name}'s site yet: press Build again on the Site page`;
      const added = await addTodo(DB, {
        kind: "build", title, link, client_id: id, place_id: site.place_id ?? null, dedupe: `build:${id}:stuck`,
      });
      if (added) stuck++;
    }
  }
  return { due, stuck };
}

// --- chat leads -----------------------------------------------------------------------------------------------------

// Chat leads quiet for 10 minutes and not yet emailed, oldest first, with what notifyLead needs (the form, so it
// doesn't read it again) and whether any mailbox could send (with none, nothing is tried: no todo, no queries).
// Only the content's business name and email are read (notifyLead's fallbacks), never the whole content (up to
// 600 KB of JSON to parse on a 10 ms CPU budget). Leads are read per site through site_leads_client (client_id,
// created_at): the CROSS JOIN keeps client_sites as the outer table, so a run reads only the last 30 days' leads, not
// every enquiry ever. ?1 = quiet since, ?2 = created since, ?3 = how many to read.
const CHAT_LEADS_SQL = `SELECT sl.*, cs.place_id AS site_place_id, c.name AS client_name, o.form AS form,
    CASE WHEN json_valid(cs.content) THEN json_extract(cs.content, '$.business.name') END AS content_name,
    CASE WHEN json_valid(cs.content) THEN json_extract(cs.content, '$.business.email') END AS content_email,
    EXISTS (SELECT 1 FROM mailboxes m WHERE m.status = 'active' AND m.role IN ('system', 'cold')) AS has_mailbox
  FROM client_sites cs
  CROSS JOIN site_leads sl ON sl.client_id = cs.client_id AND sl.created_at >= ?2
  LEFT JOIN clients c ON c.id = sl.client_id
  LEFT JOIN onboarding o ON o.client_id = sl.client_id
  WHERE sl.source = 'chat' AND sl.notified_at IS NULL AND sl.updated_at <= ?1
  ORDER BY sl.updated_at, sl.id
  LIMIT ?3`;
const LEADS_KEPT_MS = 30 * 24 * HOUR_MS; // an un-emailed chat lead older than this is left on the Site page only

async function chatLeads(DB, at, budget) {
  const { results } = await DB.prepare(CHAT_LEADS_SQL)
    .bind(iso(new Date(at.getTime() - CHAT_QUIET_MS)), iso(new Date(at.getTime() - LEADS_KEPT_MS)), LEADS_LOOKED_AT)
    .all();
  let sent = 0;
  for (const row of results ?? []) {
    if (Number(row.has_mailbox) !== 1 || sent >= LEADS_PER_RUN) break;
    if (!room(budget, COST.lead)) break;
    const { site_place_id, content_name, content_email, client_name, form, has_mailbox, ...lead } = row;
    const site = {
      client_id: lead.client_id, place_id: site_place_id ?? null, name: client_name,
      content: { business: { name: content_name ?? "", email: content_email ?? "" } }, form: objectOf(form),
    };
    const { queued } = await notifyLead(DB, lead, site, at);
    if (queued) sent++;
  }
  return sent;
}

// --- the step -------------------------------------------------------------------------------------------------------

/**
 * The tick step (everyMinutes 5). ctx = {DB, env, now, budget?}; `fetchImpl` is for tests. Returns a summary like
 * "checked 2, live 1, due 1, stuck 0, leads 0".
 */
export async function sitesStep(ctx = {}, { fetchImpl = fetch } = {}) {
  const { DB, budget } = ctx;
  const at = toDate(ctx.now);
  let checked = 0, live = 0, due = 0, stuck = 0, leads = 0;

  // 1–2. DNS checks and going live.
  if (room(budget, 1)) {
    const { results } = await DB.prepare(DUE_CHECKS_SQL)
      .bind(iso(new Date(at.getTime() - RECHECK_MS)), iso(new Date(at.getTime() - RECHECK_LIVE_MS)), DNS_PER_RUN)
      .all();
    const cutoff = (site) => iso(new Date(at.getTime() - (site.live_at ? RECHECK_LIVE_MS : RECHECK_MS)));
    for (const row of results ?? []) {
      const site = readRow(row);
      const checkDue = !site.checked_at || site.checked_at <= cutoff(site);
      if (!checkDue) {
        // Selected only because its last check passed and it has been opened since: live from that check.
        if (!room(budget, COST.goLive)) break;
        if (site.host_check.ok === true && goLiveReady(site) && (await goLive(DB, site, at))) live++;
        continue;
      }
      const cost = COST.check + (nsPending(site) ? COST.ns : 0) + (goLiveReady(site) ? COST.goLive : 0);
      if (!room(budget, cost)) break;
      const result = await checkOne(DB, site, at, fetchImpl);
      checked++;
      if (result.live) live++;
    }
  }

  // 3. Due and stuck todos.
  if (room(budget, 1 + COST.todo)) ({ due, stuck } = await todosFor(DB, at, budget));

  // 4. Chat leads.
  if (room(budget, 1 + COST.lead)) leads = await chatLeads(DB, at, budget);

  // 5. Old rate-limit windows.
  if (room(budget, 1)) await pruneHits(DB, at);

  return `checked ${checked}, live ${live}, due ${due}, stuck ${stuck}, leads ${leads}`;
}
