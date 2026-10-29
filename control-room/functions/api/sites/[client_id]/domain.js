// POST /api/sites/<client_id>/domain → the Site page's Domain, Review booster and Google Business Profile edits
// (stage 10, docs/rebuild/09-build.md sections 7, 12 and 13, Task 24), behind the login. One body may carry any of:
//   host: "smithroofing.co.uk"        the web address, stored as www.<domain> (canonicalHost, then setHost: 409 when
//                                     another client's site uses it, 400 when it isn't a web address); "" or null
//                                     clears it. In "buy" mode typing the bought domain ticks the `buy` step. The open
//                                     domain todos are reworded to name the domain.
//   step: "<id>", done: true|false    ticks or unticks a domain step: ticking closes build:<id>:domain:<step>,
//                                     unticking files it again. Auto steps (ns_wait) tick themselves: 400.
//   nameservers: [ns1, ns2]           Cloudflare's two nameservers (case B), *.ns.cloudflare.com only; saving them
//                                     ticks `zone` (its last instruction is to paste them here). [] clears them.
//   review_url: "https://g.page/…"    Nik's review link (checkReviewLink: 400 "That isn't a Google review link.");
//                                     "" or null goes back to the form's link, else Google's link for the place.
//   gbp: "invite_accepted" | "profile_created", on?: boolean
//                                     the Google Business Profile ticks: they close build:<id>:gbp. Invite accepted
//                                     only once the site is live (it starts the 90 days, via stage 11's access action,
//                                     which the page calls first).
// → {ok: true, host, domain, review_url} | {error} (400/404/409). Tested in control-room/tests/sites-api.test.mjs.
import { checkReviewLink, oneLine } from "../../../_lib/sites/copy.js";
import { getSite, setHost, updateDomain } from "../../../_lib/sites/db.js";
import { canonicalHost, normaliseHost, nsIsCloudflare } from "../../../_lib/sites/hosts.js";
import { addTodo, closeTodos } from "../../../_lib/todo.js";
import { bad, db, iso, json } from "../../../_lib/util.js";
import {
  clientIdOf, closeTodo, loadSite, NO_CLIENT, NOT_JSON, nowOf, planSteps, readBody, siteReviewUrl,
} from "../[client_id].js";

const ACTIONS = ["host", "step", "nameservers", "review_url", "gbp"];
const NOTHING = "Nothing to change: send host, step, nameservers, review_url or gbp.";
const NO_STEP = "That isn't one of this site's domain steps.";
const AUTO_STEP = "This step ticks itself once the domain's nameservers have switched to Cloudflare.";
const NS_BAD = "Paste the two nameservers Cloudflare shows for the domain, like ada.ns.cloudflare.com and bob.ns.cloudflare.com.";
const GBP_PICK = "Pick invite_accepted or profile_created.";
export const GBP_NOT_LIVE = "Tick this once the site is live: the day you tick it starts the 90 days.";
const GBP_TICKS = ["invite_accepted", "profile_created"];

const blank = (v) => v === null || (typeof v === "string" && !v.trim());
const fail = (error, status = 400) => ({ error, status });

async function setTheHost(DB, site, raw, now) {
  if (blank(raw)) {
    const r = await setHost(DB, site.client_id, null, now);
    return r.ok ? null : fail(r.error);
  }
  if (typeof raw !== "string") return fail(canonicalHost("").error);
  const c = canonicalHost(raw);
  if (!c.ok) return fail(c.error);
  const r = await setHost(DB, site.client_id, c.host, now);
  if (!r.ok) return fail(r.error, /is already used by/.test(r.error) ? 409 : 400);

  const { mode } = planSteps(site);
  const patch = { domain: c.domain };
  if (mode === "buy" && !site.domain.steps?.buy) patch.steps = { buy: iso(now) };
  const domain = await updateDomain(DB, site.client_id, patch, now);
  if (patch.steps) await closeTodo(DB, `build:${site.client_id}:domain:buy`);

  // The open domain todos were worded at Send ("the new domain"): name the domain now.
  const { steps } = planSteps({ ...site, host: c.host }, domain);
  const open = steps.filter((s) => !s.done_at);
  if (open.length) {
    await DB.batch(open.map((s) => DB.prepare("UPDATE todos SET title = ?, detail = ? WHERE dedupe = ? AND status = 'open'")
      .bind(s.title, s.detail, `build:${site.client_id}:domain:${s.id}`)));
  }
  return null;
}

async function tickStep(DB, site, body, now) {
  const id = typeof body.step === "string" ? body.step : "";
  const step = planSteps(site).steps.find((s) => s.id === id);
  if (!step) return fail(NO_STEP);
  if (step.auto) return fail(AUTO_STEP);
  const done = body.done !== false;
  await updateDomain(DB, site.client_id, { steps: { [id]: done ? iso(now) : null } }, now);
  const dedupe = `build:${site.client_id}:domain:${id}`;
  if (done) await closeTodo(DB, dedupe);
  else {
    await addTodo(DB, {
      kind: "build", dedupe, title: step.title, detail: step.detail, link: `/#/site/${site.client_id}`,
      client_id: site.client_id, place_id: site.place_id ?? null,
    });
  }
  return null;
}

async function saveNameservers(DB, site, list, now) {
  if (!Array.isArray(list)) return fail(NS_BAD);
  if (!list.length) {
    await updateDomain(DB, site.client_id, { nameservers: null }, now);
    return null;
  }
  const names = [...new Set(list.map((n) => (typeof n === "string" ? normaliseHost(n) : "")))];
  if (names.length !== 2 || names.some((n) => !n) || !nsIsCloudflare(names)) return fail(NS_BAD);
  const patch = { nameservers: names };
  const tickZone = planSteps(site).steps.some((s) => s.id === "zone" && !s.done_at);
  if (tickZone) patch.steps = { zone: iso(now) };
  await updateDomain(DB, site.client_id, patch, now);
  if (tickZone) await closeTodo(DB, `build:${site.client_id}:domain:zone`);
  return null;
}

async function saveReviewUrl(DB, site, raw, now) {
  let url;
  if (blank(raw) || raw === undefined) url = siteReviewUrl({ ...site, review_url: null });
  else {
    const checked = checkReviewLink(typeof raw === "string" ? raw : "");
    if (!checked.ok) return fail(checked.error);
    url = checked.url;
  }
  await DB.prepare("UPDATE client_sites SET review_url = ?, updated_at = ? WHERE client_id = ?")
    .bind(url ?? null, iso(now), site.client_id)
    .run();
  return null;
}

async function gbpTick(DB, site, body, now) {
  const which = body.gbp;
  if (!GBP_TICKS.includes(which)) return fail(GBP_PICK);
  const on = body.on !== false;
  if (which === "invite_accepted" && on && !site.live_at) return fail(GBP_NOT_LIVE, 409);
  await updateDomain(DB, site.client_id, { gbp: { [which]: on ? iso(now) : null } }, now);
  if (on) await closeTodos(DB, `build:${site.client_id}:gbp`);
  return null;
}

export async function onRequestPost(context) {
  const now = nowOf(context);
  const body = await readBody(context.request);
  if (!body) return bad(NOT_JSON);
  if (!ACTIONS.some((k) => k in body)) return bad(NOTHING);
  const DB = await db(context.env);
  const site = await loadSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);

  const steps = [
    ["host", () => setTheHost(DB, site, body.host, now)],
    ["nameservers", () => saveNameservers(DB, site, body.nameservers, now)],
    ["step", () => tickStep(DB, site, body, now)],
    ["review_url", () => saveReviewUrl(DB, site, body.review_url, now)],
    ["gbp", () => gbpTick(DB, site, body, now)],
  ];
  for (const [key, run] of steps) {
    if (!(key in body)) continue;
    const err = await run();
    if (err) return bad(err.error, err.status);
  }
  const after = await getSite(DB, site.client_id);
  return json({ ok: true, host: after?.host ?? null, domain: after?.domain ?? {}, review_url: oneLine(after?.review_url) || null });
}
