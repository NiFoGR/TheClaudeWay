// Setup → "Client sites" (stage 10, docs/rebuild/09-build.md sections 11-13, Task 27), behind the login:
//   GET  /api/setup/sites → {secrets: {"cf_ai:account_id", "cf_ai:token"} (booleans, never a value), model,
//        model_default, pages_host, pages_host_default, gbp_email, last_test ({at, ok, detail} | null), switches:
//        {chatbot, review_booster}, readiness (sitesReadiness), test_client ({client_id, host, status, live_at} | null)}
//   POST /api/setup/sites {account_id?, token?, model?, pages_host?, gbp_email?} → the GET answer. The secrets are
//        write-only: an empty one keeps what's saved. An empty model, Pages address or Google account clears the
//        setting (its readers fall back to the default). All fields are checked first; nothing is saved unless every
//        one is valid. A new account id, token or a different model clears chat:last_test, so the switch waits for a
//        fresh Test (the page sends the unchanged model with every Save; that keeps it).
//        Saving the Google account (care:nik_google_email, shared with stage 11's Care settings) goes through
//        saveGbpEmail (_lib/sites/onboard.js), which closes setup:gbp-email: Care settings calls it too.
//   POST ?test=chat  → testModel: {ok, detail}, stored in chat:last_test; a pass closes setup:chatbot.
//   POST ?test=pages → {ok, detail}: does the Pages address (sites:pages_host, else goldbarwebsites.pages.dev) resolve
//        to Cloudflare in DNS.
//   POST ?switch=chatbot|review_booster → offer:chatbot_live / offer:review_booster_live = '1' when sitesReadiness
//        says ready, else 409 {error: reason}; with &off=1 → '0', any time. → the GET answer.
// `context.fetchImpl` (or env.__fetch) is for tests; live it's fetch. Tested in control-room/tests/sites-setup.test.mjs.
import { secretStatus, setSecret } from "../../_lib/settings.js";
import { checkHost, HOST_CHECK_FAILED } from "../../_lib/sites/dns.js";
import { PAGES_PROJECT } from "../../_lib/sites/domain.js";
import { normaliseHost } from "../../_lib/sites/hosts.js";
import { checkGbpEmail, saveGbpEmail } from "../../_lib/sites/onboard.js";
import { sitesReadiness } from "../../_lib/sites/readiness.js";
import { CHAT_MODEL_DEFAULT, testModel } from "../../_lib/sites/workersAi.js";
import { closeTodos } from "../../_lib/todo.js";
import { bad, db, json, parseJson } from "../../_lib/util.js";
import { readJson } from "./mailboxes.js";

const SECRETS = ["cf_ai:account_id", "cf_ai:token"];
const PAGES_DEFAULT = `${PAGES_PROJECT}.pages.dev`;
const SWITCHES = { chatbot: "offer:chatbot_live", review_booster: "offer:review_booster_live" };
const KEYS = { model: "chat:model", pages_host: "sites:pages_host" };

// The same shapes workersAi.js accepts before it builds the API URL.
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_RE = /^@[a-z0-9_-]+(?:\/[a-z0-9._-]+){1,3}$/i;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,200}$/;
const PAGES_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pages\.dev$/;

export const SITES_SETUP_ERRORS = {
  json: "That request couldn't be read (it wasn't JSON). Reload Setup and try again.",
  text: "Each Client sites setting must be text.",
  account: "The Cloudflare account ID doesn't look right: copy it again from the Cloudflare dashboard.",
  token: "That doesn't look like a Cloudflare API token: make one with the 'Workers AI' template and paste it again.",
  model: "That doesn't look like a Workers AI model name. Type it like @cf/google/gemma-3-12b-it.",
  pages: "That isn't a Pages address. Type it like goldbarwebsites.pages.dev.",
  email: "That doesn't look like an email address.",
  switch: "There's no switch called that.",
  test: "There's no test called that: use Test next to the chatbot connection or the Pages address.",
};

const UPSERT_SQL = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
const DELETE_SQL = "DELETE FROM settings WHERE key = ?";
const READ_SQL = `SELECT key, value FROM settings WHERE key IN ('chat:model', 'sites:pages_host', 'care:nik_google_email',
  'chat:last_test', 'offer:chatbot_live', 'offer:review_booster_live')`;
const TEST_CLIENT_SQL = `SELECT cs.client_id, cs.host, cs.status, cs.live_at FROM client_sites cs
  JOIN clients c ON c.id = cs.client_id WHERE cs.is_test = 1 AND c.notes = 'TEST' ORDER BY cs.created_at DESC LIMIT 1`;

const fetchOf = (context) => context.fetchImpl ?? context.env?.__fetch; // tests only; undefined live
const nowOf = (context) => (context?.now ? new Date(context.now) : new Date());

// "https://GoldBar.pages.dev/" as typed → "goldbar.pages.dev"; "" when it isn't one project's *.pages.dev address.
function pagesHostOf(typed) {
  const host = normaliseHost(typed.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0]);
  return PAGES_RE.test(host) ? host : "";
}

/** The GET answer: whether each secret is set, never its value. */
async function status(DB, now) {
  const [{ results }, testClient, secrets, readiness] = await Promise.all([
    DB.prepare(READ_SQL).all(),
    DB.prepare(TEST_CLIENT_SQL).first(),
    secretStatus(DB, SECRETS),
    sitesReadiness(DB, now),
  ]);
  const s = Object.fromEntries((results ?? []).map((r) => [r.key, r.value]));
  const last = parseJson(s["chat:last_test"], null);
  return {
    secrets,
    model: s["chat:model"] ?? "",
    model_default: CHAT_MODEL_DEFAULT,
    pages_host: s["sites:pages_host"] ?? "",
    pages_host_default: PAGES_DEFAULT,
    gbp_email: s["care:nik_google_email"] ?? "",
    last_test: last && typeof last === "object" && !Array.isArray(last)
      ? { at: typeof last.at === "string" ? last.at : null, ok: last.ok === true, detail: typeof last.detail === "string" ? last.detail : "" }
      : null,
    switches: { chatbot: s["offer:chatbot_live"] === "1", review_booster: s["offer:review_booster_live"] === "1" },
    readiness,
    test_client: testClient
      ? { client_id: testClient.client_id, host: testClient.host ?? null, status: testClient.status, live_at: testClient.live_at ?? null }
      : null,
  };
}

export async function onRequestGet(context) {
  const DB = await db(context.env);
  return json(await status(DB, nowOf(context)));
}

// Every field checked before anything is written: {secrets: [[name, value]], settings: [[key, value|""]], gbpEmail?}
// or {error}.
function changesFrom(body) {
  const out = { secrets: [], settings: [] };
  for (const f of ["account_id", "token", "model", "pages_host", "gbp_email"]) {
    if (body[f] === undefined || body[f] === null) continue;
    if (typeof body[f] !== "string") return { error: SITES_SETUP_ERRORS.text };
  }
  const val = (f) => (typeof body[f] === "string" ? body[f].trim() : null);

  const account = val("account_id");
  if (account) {
    if (!ACCOUNT_RE.test(account)) return { error: SITES_SETUP_ERRORS.account };
    out.secrets.push(["cf_ai:account_id", account]);
  }
  const token = val("token");
  if (token) {
    if (!TOKEN_RE.test(token)) return { error: SITES_SETUP_ERRORS.token };
    out.secrets.push(["cf_ai:token", token]);
  }
  const model = val("model");
  if (model !== null) {
    if (model && !MODEL_RE.test(model)) return { error: SITES_SETUP_ERRORS.model };
    out.settings.push([KEYS.model, model]);
  }
  const pages = val("pages_host");
  if (pages !== null) {
    const host = pages ? pagesHostOf(pages) : "";
    if (pages && !host) return { error: SITES_SETUP_ERRORS.pages };
    out.settings.push([KEYS.pages_host, host]);
  }
  if (typeof body.gbp_email === "string") {
    // the shared check (saveGbpEmail's), so Setup and stage 11's Care settings accept the same addresses
    if (checkGbpEmail(body.gbp_email).error) return { error: SITES_SETUP_ERRORS.email };
    out.gbpEmail = body.gbp_email;
  }
  return out;
}

async function save(DB, body) {
  const changes = changesFrom(body);
  if (changes.error) return changes;
  const stmts = changes.settings.map(([key, value]) => (value ? DB.prepare(UPSERT_SQL).bind(key, value) : DB.prepare(DELETE_SQL).bind(key)));
  // The page sends the model with every Save, so only a different model (empty = the default) counts as a change.
  const model = changes.settings.find(([key]) => key === KEYS.model);
  let modelChanged = false;
  if (model) {
    const saved = await DB.prepare("SELECT value FROM settings WHERE key = 'chat:model'").first("value");
    modelChanged = (model[1] || CHAT_MODEL_DEFAULT) !== ((typeof saved === "string" && saved.trim()) || CHAT_MODEL_DEFAULT);
  }
  const reconnect = changes.secrets.length > 0 || modelChanged;
  if (reconnect) stmts.push(DB.prepare(DELETE_SQL).bind("chat:last_test"));
  if (stmts.length) await DB.batch(stmts);
  for (const [name, value] of changes.secrets) await setSecret(DB, name, value);
  // saves care:nik_google_email and closes setup:gbp-email, as stage 11's Care settings does
  if (changes.gbpEmail !== undefined) await saveGbpEmail(DB, changes.gbpEmail);
  return {};
}

async function testPages(DB, fetchImpl) {
  const saved = await DB.prepare("SELECT value FROM settings WHERE key = 'sites:pages_host'").first("value");
  const host = (typeof saved === "string" && saved.trim()) || PAGES_DEFAULT;
  const checked = await checkHost(host, host, fetchImpl ? { fetchImpl } : {});
  if (checked.ok) return { ok: true, detail: `${host} answers ✓: clients' www records will point here.` };
  if (checked.detail === HOST_CHECK_FAILED) return { ok: false, detail: HOST_CHECK_FAILED };
  return {
    ok: false,
    detail: `${host} doesn't lead to a Cloudflare Pages project. Copy the address from Cloudflare → Workers & Pages → your project (it ends .pages.dev).`,
  };
}

async function flip(DB, name, off, now) {
  const key = SWITCHES[name];
  if (!off) {
    const readiness = (await sitesReadiness(DB, now))[name];
    if (!readiness.ready) return { error: readiness.reason, status: 409 };
  }
  await DB.prepare(UPSERT_SQL).bind(key, off ? "0" : "1").run();
  return {};
}

export async function onRequestPost(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const q = new URL(context.request.url).searchParams;

  if (q.has("test")) {
    const fetchImpl = fetchOf(context);
    if (q.get("test") === "chat") {
      const r = await testModel(DB, { now, ...(fetchImpl ? { fetchImpl } : {}) });
      if (r.ok) await closeTodos(DB, "setup:chatbot");
      return json({ ok: r.ok, detail: r.detail });
    }
    if (q.get("test") === "pages") return json(await testPages(DB, fetchImpl));
    return bad(SITES_SETUP_ERRORS.test);
  }

  if (q.has("switch")) {
    const name = q.get("switch");
    if (!Object.hasOwn(SWITCHES, name)) return bad(SITES_SETUP_ERRORS.switch);
    const r = await flip(DB, name, q.get("off") === "1", now);
    if (r.error) return bad(r.error, r.status);
    return json(await status(DB, now));
  }

  const body = await readJson(context.request);
  if (!body) return bad(SITES_SETUP_ERRORS.json);
  const r = await save(DB, body);
  if (r.error) return bad(r.error);
  return json(await status(DB, now));
}
