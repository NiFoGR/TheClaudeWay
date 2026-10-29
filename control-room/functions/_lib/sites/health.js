// Health lights for client sites and their chat (stage 10, docs/rebuild/09-build.md section 14 and Task 28).
//
// siteLights is pure: the `sites` light is red when a site is past its due-live time without live_at, or a live
// site's DNS check failed twice in a row; amber when a site is due live within 48 h, when Claude hasn't posted content
// 3 h after a build fire, or at 80+ client domains on the Pages project (40 live sites, www + apex; section 15); green
// otherwise; grey with no client sites. The `chat` light is amber when the chatbot couldn't answer more than 10 times
// today (chat_usage.ai_errors, UK day) or the all-sites daily cap was hit; grey when no site has the chat on.
// A site that's been taken offline (status off) counts as a client site but is never late, stuck or failing.
//
// siteLightsFromDb reads every fact in 1 D1 query, with bounded rows read. Both lights are registered with stage 0's
// registerLight when this module loads (one function per light, sharing that one query); sites/tick.js and
// api/health.js import it, so the lights show wherever health is worked out. Stage 0's computeLights is not edited.
import { registerLight } from "../health.js";
import { ukDate } from "../ukTime.js";
import { parseJson } from "../util.js";
import { chatEnabled } from "./chat.js";
import { countdown, ukShortDay } from "./countdown.js";
import { CHAT_DAILY_CAP_ALL } from "./workersAi.js"; // the all-sites chat cap per UK day (section 11's check 4)

const HOUR_MS = 3_600_000;
const DUE_SOON_HOURS = 48;
const STUCK_MS = 3 * HOUR_MS; // content not posted this long after a build fire
const DNS_FAILS = 2; // a live site's DNS check failing this many times in a row
const DOMAINS_WARN = 80; // of ~100 custom domains per Pages project on the free plan (section 15)
const AI_ERRORS_MAX = 10; // more than this today is amber

const DNS_FIX = "Open the Site page and press Check now; follow the domain steps again.";
const STUCK_FIX = "Press Build again on the Site page; if it fails, check the build Routine on Setup → Claude.";
const CHANGES_FIX =
  "Press Ask Claude for changes again on the Site page; if it fails, check the build Routine on Setup → Claude.";
const DOMAINS_FIX = "Nothing breaks yet: tell Claude it's time to plan a second Pages project for new client sites.";
const AI_ERRORS_FIX =
  'Press Setup → "Client sites" → Test. If it fails, do what it says; if it works, Cloudflare had a bad spell and visitors were offered a call back instead.';
const CAP_FIX =
  "Nothing to fix: the chat starts again at midnight, and until then visitors are offered a call back. If one site is being flooded, switch its chatbot off on its Site page.";
const dueFix = (name) =>
  `Open ${name}'s Site page and do what its 'due' todo says; send the temporary link if the domain is the hold-up.`;

// Times read as ms, or null when missing or unreadable.
function msOf(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
const toMs = (now) => msOf(now instanceof Date || typeof now === "string" ? now : new Date(now)) ?? Date.now();
const objectOf = (value) => {
  const v = typeof value === "string" ? parseJson(value, null) : value;
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const nameOf = (s) => String(s.name ?? "").replace(/\s+/g, " ").trim() || "A client";
const light = (name, level, detail, fix = "") => ({ name, level, detail, fix });
const RANK = { red: 0, amber: 1 };

// The worst problem's light, saying how many more there are.
function worst(name, problems) {
  const sorted = [...problems].sort((a, b) => RANK[a.level] - RANK[b.level] || a.order - b.order || a.key - b.key);
  const [first] = sorted;
  const more = sorted.length - 1;
  const detail = more
    ? `${first.detail}${first.detail.endsWith(".") ? "" : "."} Plus ${plural(more, "more problem", "more problems")} on the Sites page.`
    : first.detail;
  return light(name, first.level, detail, first.fix);
}

// Client domains on the Pages project: a www host is two (www + apex), any other host one.
const domainCount = (hosts) =>
  hosts.filter((h) => typeof h === "string" && h).reduce((n, h) => n + (h.startsWith("www.") ? 2 : 1), 0);

function sitesLight(sites, liveDomains, at) {
  if (!sites.length) return light("sites", "grey", "No client sites yet");
  const problems = [];
  for (const s of sites) {
    if (s.status === "off") continue;
    const name = nameOf(s);
    if (!s.live_at && msOf(s.due_live_at) !== null) {
      const cd = countdown(s.due_live_at, null, new Date(at));
      if (cd.hoursLeft < 0) {
        problems.push({ level: "red", order: 0, key: cd.hoursLeft, detail: `${name}'s site is ${cd.label}.`, fix: dueFix(name) });
      } else if (cd.hoursLeft < DUE_SOON_HOURS) {
        const left = cd.hoursLeft < 1 ? "under an hour" : `${plural(Math.floor(cd.hoursLeft), "hour", "hours")}`;
        problems.push({
          level: "amber", order: 0, key: cd.hoursLeft,
          detail: `${name}'s site is due live ${ukShortDay(s.due_live_at)} (${left} left) and isn't live yet.`,
          fix: dueFix(name),
        });
      }
    }
    const check = objectOf(s.host_check);
    if (s.status === "live" && s.live_at && s.host && Number(check?.fails) >= DNS_FAILS) {
      problems.push({
        level: "red", order: 1, key: 0, detail: `${s.host} no longer points at us. Check the domain's DNS.`, fix: DNS_FIX,
      });
    }
    const fired = msOf(s.build_fired_at);
    const contentAt = msOf(s.content_at);
    if (fired !== null && at - fired >= STUCK_MS && (contentAt === null || contentAt < fired)) {
      const built = s.has_content === true || Number(s.has_content) === 1 || contentAt !== null;
      problems.push(built
        ? { level: "amber", order: 1, key: fired, detail: `Claude hasn't posted the changes to ${name}'s site`, fix: CHANGES_FIX }
        : { level: "amber", order: 1, key: fired, detail: `Claude hasn't built ${name}'s site`, fix: STUCK_FIX });
    }
  }
  const hosts = (Array.isArray(liveDomains) ? liveDomains : sites.filter((s) => s.status === "live").map((s) => s.host))
    .filter((h) => typeof h === "string" && h);
  const domains = domainCount(hosts);
  // 80+ domains, or 40+ live sites (section 14) when some have only one (a test site's subdomain).
  if (domains >= DOMAINS_WARN || hosts.length >= DOMAINS_WARN / 2) {
    problems.push({
      level: "amber", order: 2, key: 0,
      detail: `You're at ${domains} of ~100 client domains on this Pages project: time to plan the next one.`,
      fix: DOMAINS_FIX,
    });
  }
  if (problems.length) return worst("sites", problems);
  const live = sites.filter((s) => s.status === "live" && s.live_at).length;
  return light("sites", "green", `${plural(sites.length, "client site", "client sites")}, ${live} live: none late or stuck`);
}

function chatLight(sites, chatToday, at) {
  const on = sites.filter((s) => s.status !== "off" && s.chat_on === true);
  if (!on.length) return light("chat", "grey", "No client site has the chatbot on");
  const today = chatToday && typeof chatToday === "object" ? chatToday : {};
  const messages = Math.max(0, Math.floor(Number(today.messages) || 0));
  const errors = Math.max(0, Math.floor(Number(today.ai_errors) || 0));
  const problems = [];
  if (errors > AI_ERRORS_MAX) {
    problems.push({
      level: "amber", order: 0, key: 0,
      detail: `The chatbot couldn't answer ${plural(errors, "time", "times")} today (${ukDate(new Date(at))}): Cloudflare Workers AI gave an error or took over 8 seconds`,
      fix: AI_ERRORS_FIX,
    });
  }
  if (messages >= CHAT_DAILY_CAP_ALL) {
    problems.push({
      level: "amber", order: 1, key: 0,
      detail: `The chat reached today's limit of ${thousands(CHAT_DAILY_CAP_ALL)} messages across all sites`,
      fix: CAP_FIX,
    });
  }
  if (problems.length) {
    return light("chat", "amber", problems.map((p) => p.detail).join("; "), problems.map((p) => p.fix).join(" "));
  }
  return light(
    "chat", "green",
    `Chatbot on for ${plural(on.length, "site", "sites")}: ${plural(messages, "message", "messages")} today, ${errors} not answered`,
  );
}

/**
 * The `sites` and `chat` lights (pure), in that order, each exactly {name, level, detail, fix}.
 * facts = {sites: [{client_id, name, status, host, host_check (object or JSON), live_at, due_live_at, has_content,
 * content_at, build_fired_at (the last accepted build/changes fire for the client), chat_on}], chatToday: {messages,
 * ai_errors} summed over all sites for today's UK day, liveDomains?: the live sites' hosts (default: worked out from
 * `sites`)}.
 */
export function siteLights({ sites, chatToday, liveDomains } = {}, now = new Date()) {
  const at = toMs(now);
  const list = (Array.isArray(sites) ? sites : []).filter((s) => s && typeof s === "object");
  return [sitesLight(list, liveDomains, at), chatLight(list, chatToday, at)];
}

// One query: every site with its client, clock, today's chat_usage row and the last accepted build fire for it, and
// (on every row) the chatbot offer switch and whether the Workers AI secrets are set. ?1 = today's UK date, ?2 = how
// many of the newest routine_fires rows to look at. Rows read stay bounded however long the logs grow (the health
// step runs every 5 minutes): routine_fires has no index, so only its newest FIRES_LOOKED_AT rows by rowid are read
// (as setupStatus.js does), once; chat_usage is read by its primary key (client_id, day), one row per site; clients,
// onboarding and settings by theirs. A build fire older than that window no longer counts (by then the site is
// days late and the due light says so).
const FIRES_LOOKED_AT = 1000;
const FACTS_SQL = `WITH fires AS MATERIALIZED (
    SELECT reason, MAX(at) AS at FROM routine_fires
    WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM routine_fires) - ?2
      AND routine = 'build' AND error IS NULL
    GROUP BY reason)
  SELECT cs.client_id, cs.status, cs.host, cs.host_check, cs.is_test, cs.features, cs.live_at,
    cs.content_at, cs.content IS NOT NULL AS has_content, c.name AS name, c.package AS package,
    c.cancelled_on AS cancelled_on, o.due_live_at AS due_live_at,
    (SELECT MAX(f.at) FROM fires f
       WHERE f.reason IN ('build: client ' || cs.client_id, 'changes: client ' || cs.client_id)) AS build_fired_at,
    COALESCE(u.messages, 0) AS chat_messages, COALESCE(u.ai_errors, 0) AS chat_ai_errors,
    (SELECT s.value FROM settings s WHERE s.key = 'offer:chatbot_live') AS chatbot_live,
    EXISTS (SELECT 1 FROM settings s WHERE s.key = 'secret:cf_ai:account_id' AND s.value <> '') AS has_account,
    EXISTS (SELECT 1 FROM settings s WHERE s.key = 'secret:cf_ai:token' AND s.value <> '') AS has_token
  FROM client_sites cs
  LEFT JOIN clients c ON c.id = cs.client_id
  LEFT JOIN onboarding o ON o.client_id = cs.client_id
  LEFT JOIN chat_usage u ON u.client_id = cs.client_id AND u.day = ?1`;

/** The two lights from D1 (1 query). */
export async function siteLightsFromDb(DB, now = new Date()) {
  const at = toMs(now);
  const { results } = await DB.prepare(FACTS_SQL).bind(ukDate(new Date(at)), FIRES_LOOKED_AT).all();
  const rows = results ?? [];
  const sites = rows.map((r) => ({
    ...r,
    has_content: Number(r.has_content) === 1,
    chat_on: chatEnabled({
      site: r,
      settings: { "offer:chatbot_live": r.chatbot_live },
      secrets: { "cf_ai:account_id": Number(r.has_account) === 1, "cf_ai:token": Number(r.has_token) === 1 },
    }).on,
  }));
  // Today's totals across all sites (a client's chat_usage rows go when its site does).
  const sum = (key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  const chatToday = { messages: sum("chat_messages"), ai_errors: sum("chat_ai_errors") };
  return siteLights({ sites, chatToday }, at);
}

// The two registered lights come from one query: healthFromDb calls them one after the other with the same DB and
// time, so the second reuses the first's answer (only the latest call is kept).
let last = null;
function sharedLights(DB, now) {
  const at = toMs(now);
  if (last && last.DB === DB && last.at === at) return last.lights;
  const lights = siteLightsFromDb(DB, at);
  last = { DB, at, lights };
  return lights;
}

registerLight(async (DB, env, now) => (await sharedLights(DB, now))[0]);
registerLight(async (DB, env, now) => (await sharedLights(DB, now))[1]);
