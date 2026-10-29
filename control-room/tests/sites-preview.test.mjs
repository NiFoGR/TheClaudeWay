// Nik's preview of a client's site and the temporary public link (09-build.md Part A §7, Part B Task 23):
// /c/<slug>/… is behind the login, any status with content, with the slim preview bar, noindex, links under
// /c/<slug>/ and the form and chat replaced by "Works once the site is live."; /w/<slug>/… is public on our host, only
// while the site is live, noindex, with the canonical link pointing at the client's real host.
// Run: node --test control-room/tests/sites-preview.test.mjs control-room/tests/site.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";
import * as previewRoute from "../functions/c/[slug]/[[path]].js";
import * as tempRoute from "../functions/w/[slug]/[[path]].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const HOST = "www.smithroofing.co.uk";
const SLUG = "smith-roofing-ab12cd";
const REVIEW = "https://search.google.com/local/writereview?placeid=ChIJsmith";
const CONTENT = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const FORM = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8")).form;
const PASSWORD = "test-password-123";
const COOKIE = `cr_session=${createHmac("sha256", PASSWORD).update("goldbar-control-room-session").digest("hex")}`;
const AT = "2026-10-10T09:00:00Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

async function addSite(DB, { id, name, slug, status, host = null, content = CONTENT, place_id = null }) {
  await insert(DB, "clients", {
    id, name, place_id, package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-10", created_at: AT,
  });
  await insert(DB, "onboarding", {
    client_id: id, token: id.padEnd(32, "T"), status: status === "live" ? "live" : "review", form: JSON.stringify(FORM),
    submitted_at: AT, due_live_at: "2026-10-17T09:00:00Z", created_at: AT,
  });
  await insert(DB, "client_sites", {
    client_id: id, slug, place_id, host, content: content ? JSON.stringify(content) : null, status, domain: "{}",
    review_url: REVIEW, features: "{}", live_at: status === "live" ? "2026-10-15T09:00:00Z" : null,
    content_at: content ? "2026-10-14T09:00:00Z" : null, created_at: AT, updated_at: AT,
  });
}

// Smith Roofing in review (content written, host known), its live twin for /w/, and a draft with no content yet.
async function setup({ status = "review" } = {}) {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "Smith Roofing", trade: "roofer", search_town: "Swindon", maps_url: "https://maps.google.com/?cid=123",
    rating: 4.8, review_count: 37, first_seen_at: AT, updated_at: AT,
  });
  await addSite(DB, { id: "c1", name: "Smith Roofing", slug: SLUG, status, host: HOST, place_id: "p1" });
  await addSite(DB, { id: "c2", name: "Empty Ltd", slug: "empty-ltd-zz99yy", status: "draft", content: null });
  return DB;
}

// The route function as Pages runs it (params from the path), through the middleware like a real request.
function routeFor(path) {
  if (path.startsWith("/c/")) return previewRoute.onRequest;
  if (path.startsWith("/w/")) return tempRoute.onRequest;
  return null;
}

function paramsOf(path) {
  const m = /^\/[cw]\/([^/]+)(?:\/(.*))?$/.exec(path.split("?")[0]);
  return m ? { slug: m[1], path: m[2] ? m[2].split("/").filter(Boolean) : [] } : {};
}

function server(DB, env = { CONTROL_ROOM_PASSWORD: PASSWORD }) {
  const nexts = [];
  const call = (url, init = {}) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname + new URL(url).search;
    const ctx = { request, env: { DB, ...env }, params: paramsOf(path), waitUntil: () => {} };
    const next = async () => {
      nexts.push(path);
      const route = routeFor(path);
      return route ? route(ctx) : new Response("the Control Room", { status: 200 });
    };
    return middleware({ ...ctx, next });
  };
  return { call, nexts };
}

const logged = { headers: { cookie: COOKIE } };

test("/c/<slug>/<page> without the login → 303 to /login (the route never runs)", async () => {
  const DB = await setup();
  const { call, nexts } = server(DB);
  for (const host of ["goldbarwebsites.pages.dev", "control.aetoswebsites.com"]) {
    const res = await call(`https://${host}/c/${SLUG}/services/roof-repairs`);
    assert.equal(res.status, 303, host);
    assert.equal(res.headers.get("location"), "/login", host);
  }
  assert.equal(nexts.length, 0);
});

test("/c/<slug>/ on the root domain is its 404 page, not a preview, even with the login", async () => {
  const { call, nexts } = server(await setup());
  const res = await call(`https://aetoswebsites.com/c/${SLUG}/`, logged);
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes("Preview of"));
  assert.equal(nexts.length, 0);
});

test("/c/<slug>/<page> with the login → 200: the preview bar, noindex, every link under /c/<slug>/, no form, no chat", async () => {
  const { call } = server(await setup());
  const res = await call(`https://goldbarwebsites.pages.dev/c/${SLUG}/services/roof-repairs`, logged);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.ok(html.includes("Preview of Smith Roofing's site"));
  assert.ok(html.includes("Ready to approve"), "the status label");
  assert.ok(html.includes('<a href="/#/sites">Back to the Control Room</a>'));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(html.includes(`href="/c/${SLUG}/"`), "home link");
  assert.ok(html.includes(`href="/c/${SLUG}/about"`), "nav link");
  assert.ok(html.includes(`href="/c/${SLUG}/privacy"`), "privacy link");
  // Every internal link is under the preview's base: none points at the client's real paths.
  for (const [, href] of html.matchAll(/<a [^>]*href="([^"]*)"/g)) {
    if (href.startsWith("/") && !href.startsWith("//")) {
      assert.ok(href.startsWith(`/c/${SLUG}/`) || href === "/#/sites", href);
    }
  }
  assert.ok(html.includes("Works once the site is live."));
  assert.ok(!html.includes('id="cf"'), "no contact form");
  assert.ok(!html.includes("/s/contact"), "no form action");
  assert.ok(!html.includes("/s/chat.js"), "no chat");
});

test("/c/<slug>/ draws the home page; /c/<slug> without the slash too; any status with content (live and off)", async () => {
  for (const status of ["review", "live", "off"]) {
    const { call } = server(await setup({ status }));
    for (const path of [`/c/${SLUG}/`, `/c/${SLUG}`]) {
      const res = await call(`https://goldbarwebsites.pages.dev${path}`, logged);
      assert.equal(res.status, 200, `${status} ${path}`);
      const html = await res.text();
      assert.ok(html.includes("Preview of Smith Roofing's site"), `${status} ${path}`);
      assert.ok(html.includes("<title>Roofing contractor in Swindon | Smith Roofing – Roof repairs, flat roofs</title>"), `${status} ${path}`);
    }
  }
});

test("/c/<slug>/privacy is the privacy page under the preview; an unknown page is the site's 404 with a link home", async () => {
  const { call } = server(await setup());
  const privacy = await call(`https://goldbarwebsites.pages.dev/c/${SLUG}/privacy`, logged);
  assert.equal(privacy.status, 200);
  assert.ok((await privacy.text()).includes("Preview of Smith Roofing's site"));
  const missing = await call(`https://goldbarwebsites.pages.dev/c/${SLUG}/nope`, logged);
  assert.equal(missing.status, 404);
  const html = await missing.text();
  assert.ok(html.includes("Sorry, that page isn't here."));
  assert.ok(html.includes(`href="/c/${SLUG}/"`));
});

test("/c/<slug>/about/ → 301 to /c/<slug>/about", async () => {
  const { call } = server(await setup());
  const res = await call(`https://goldbarwebsites.pages.dev/c/${SLUG}/about/`, logged);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `/c/${SLUG}/about`);
});

test("/c/<slug>/ for a site with no content → 404 \"Claude hasn't written this site yet.\"; an unknown slug → 404", async () => {
  const { call } = server(await setup());
  const res = await call("https://goldbarwebsites.pages.dev/c/empty-ltd-zz99yy/", logged);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.ok((await res.text()).includes("Claude hasn't written this site yet."));
  const unknown = await call("https://goldbarwebsites.pages.dev/c/no-such-site-000000/", logged);
  assert.equal(unknown.status, 404);
  assert.ok(!(await unknown.text()).includes("Smith Roofing"));
});

test("/c/<slug>/ only reads: POST is a 405", async () => {
  const { call } = server(await setup());
  const res = await call(`https://goldbarwebsites.pages.dev/c/${SLUG}/contact`, { method: "POST", body: "x", headers: { cookie: COOKIE } });
  assert.equal(res.status, 405);
});

test("/w/<slug>/ for a review site → 404 (no login needed to see that), with nothing of the site on it", async () => {
  const { call } = server(await setup({ status: "review" }));
  for (const path of [`/w/${SLUG}/`, `/w/${SLUG}/about`]) {
    const res = await call(`https://aetoswebsites.com${path}`);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    const html = await res.text();
    assert.ok(!html.includes("Smith Roofing"), path);
    assert.ok(!html.includes("Preview of"), path);
  }
  for (const status of ["draft", "off"]) {
    const { call: c2 } = server(await setup({ status }));
    assert.equal((await c2(`https://aetoswebsites.com/w/${SLUG}/`)).status, 404, status);
  }
});

test("/w/<slug>/ for a live site → 200 on our host without a login: noindex, canonical to the real host, no preview bar", async () => {
  const { call, nexts } = server(await setup({ status: "live" }));
  for (const host of ["aetoswebsites.com", "goldbarwebsites.pages.dev", "control.aetoswebsites.com"]) {
    const res = await call(`https://${host}/w/${SLUG}/`);
    assert.equal(res.status, 200, host);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", host);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", host);
    assert.equal(res.headers.get("set-cookie"), null, host);
    const html = await res.text();
    assert.ok(html.includes('<meta name="robots" content="noindex">'), host);
    assert.ok(html.includes(`<link rel="canonical" href="https://${HOST}/">`), host);
    assert.ok(!html.includes("Preview of"), host);
    assert.ok(!html.includes("ae-bar"), host);
    assert.ok(!html.includes("Works once the site is live."), host);
    assert.ok(html.includes(`href="/w/${SLUG}/about"`), host);
  }
  assert.equal(nexts.length, 3);
  const page = await call(`https://aetoswebsites.com/w/${SLUG}/services/roof-repairs`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(`<link rel="canonical" href="https://${HOST}/services/roof-repairs">`));
});

test("/w/<slug>/ has a working contact form: it posts to /w/<slug>/s/contact and thanks the visitor there", async () => {
  const DB = await setup({ status: "live" });
  const { call } = server(DB);
  const home = await (await call(`https://aetoswebsites.com/w/${SLUG}/contact`)).text();
  assert.ok(home.includes(`action="/w/${SLUG}/s/contact"`));
  assert.ok(!home.includes("/s/chat.js"), "no chat on the temporary link");
  const form = new FormData();
  form.set("name", "Dave");
  form.set("phone", "07700 900123");
  form.set("message", "Leak over the porch");
  form.set("t", "9000");
  form.set("page", "/contact");
  const res = await call(`https://aetoswebsites.com/w/${SLUG}/s/contact`, { method: "POST", body: form });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/w/${SLUG}/contact?sent=1`);
  const row = await DB.prepare("SELECT client_id, name, source FROM site_leads").first();
  assert.deepEqual({ ...row }, { client_id: "c1", name: "Dave", source: "form" });
  const thanks = await call(`https://aetoswebsites.com/w/${SLUG}/contact?sent=1`);
  assert.equal(thanks.status, 200);
  const html = await thanks.text();
  assert.ok(html.includes("Thanks for your message"));
  assert.ok(!html.includes('id="cf"'));
});

test("/w/<slug>/<unknown> → the site's 404 page (links stay under /w/<slug>/); HEAD has no body", async () => {
  const { call } = server(await setup({ status: "live" }));
  const res = await call(`https://aetoswebsites.com/w/${SLUG}/nope`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.ok(html.includes("Sorry, that page isn't here."));
  assert.ok(html.includes(`href="/w/${SLUG}/"`));
  const head = await call(`https://aetoswebsites.com/w/${SLUG}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("the preview bar escapes the business name (only the apostrophe is written as itself)", async () => {
  const DB = fakeD1();
  const content = { ...CONTENT, business: { ...CONTENT.business, name: `O'Neil <script>x</script> & Sons` } };
  await addSite(DB, { id: "c9", name: "O'Neil", slug: "oneil-sons-aa11bb", status: "review", host: HOST, content });
  const { call } = server(DB);
  const html = await (await call("https://goldbarwebsites.pages.dev/c/oneil-sons-aa11bb/", logged)).text();
  assert.ok(html.includes("Preview of O'Neil &lt;script&gt;x&lt;/script&gt; &amp; Sons's site"));
  assert.ok(!html.includes("<script>x</script>"));
});

test("the preview bar keeps a name with $ in it as written (no replacement patterns)", async () => {
  const DB = fakeD1();
  for (const [i, name] of [`Cash$'s Roofing`, "Roofs $& More", "A$`B Ltd"].entries()) {
    const content = { ...CONTENT, business: { ...CONTENT.business, name } };
    const slug = `cash-roofing-aa11b${i}`;
    await addSite(DB, { id: `c${i + 20}`, name, slug, status: "review", host: `www.cash${i}.co.uk`, content });
    const { call } = server(DB);
    const res = await call(`https://goldbarwebsites.pages.dev/c/${slug}/`, logged);
    assert.equal(res.status, 200, name);
    const html = await res.text();
    const bar = html.match(/<div class="ae-bar"><p>(.*?) · <a href="\/#\/sites">/);
    assert.ok(bar, name);
    assert.ok(bar[1].startsWith("Preview of ") && bar[1].includes("site · Ready to approve"), `${name}: ${bar[1].slice(0, 200)}`);
    assert.equal((html.match(/<!doctype html>/gi) ?? []).length, 1, `${name}: the page is drawn once`);
    assert.equal((html.match(/class="ae-bar"/g) ?? []).length, 1, name);
  }
});

test("/w/<slug>/ that can't be drawn → a plain 500 that names nobody and shows no error detail", async () => {
  const DB = fakeD1();
  await addSite(DB, { id: "c7", name: "Broken Ltd", slug: "broken-ltd-aa11bb", status: "live", host: HOST, content: { business: { name: "Broken Ltd" } } });
  const { call } = server(DB);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let res;
  try {
    res = await call("https://aetoswebsites.com/w/broken-ltd-aa11bb/");
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.ok(html.includes("Sorry, this page can't be shown just now. Please try again in a minute."));
  assert.ok(!html.includes("Broken Ltd"));
  assert.ok(!html.includes("SiteContent"));
  assert.equal(errors.length, 1);
});
