// Client sites served by hostname from the same Pages project (09-build.md Part A §7, Part B Task 22):
// serveClientHost walks section 7's routing table top to bottom (not live → 404, http → https, www twin → the stored
// host, trailing slash dropped, pages, old-site redirects, sitemap/robots/privacy, /s/*, the site's own 404 page), and
// _middleware.js calls it first for any host that isn't ours. No row → null, and the Control Room carries on as before.
// Run: node --test control-room/tests/sites-serve.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { renderMissingPage } from "../functions/_lib/sites/pages.js";
import { CLIENT_CSP, serveClientHost } from "../functions/_lib/sites/serve.js";
import { siteData } from "../functions/_lib/sites/sitedata.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-28T10:00:00Z");
const HOST = "www.smithroofing.co.uk";
const REVIEW = "https://search.google.com/local/writereview?placeid=ChIJsmith";
const CONTENT = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const FORM = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8")).form;
const LEAD = { rating: 4.8, review_count: 37, maps_url: "https://maps.google.com/?cid=123", trade: "roofer" };
const PASSWORD = "test-password-123";
const COOKIE = `cr_session=${createHmac("sha256", PASSWORD).update("goldbar-control-room-session").digest("hex")}`;
const AT = "2026-10-10T09:00:00Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const one = async (DB, sql, ...binds) => DB.prepare(sql).bind(...binds).first();

async function addClient(DB, { id, name, host, status, pkg = "full", features = "{}", is_test = 0, place_id = null, seen_at = null }) {
  await insert(DB, "clients", {
    id, name, place_id, package: pkg, build_fee_pence: 195000, monthly_pence: pkg === "website" ? 0 : 24900,
    free_days: 60, paid_on: "2026-10-10", created_at: AT,
  });
  await insert(DB, "onboarding", {
    client_id: id, token: id.padEnd(32, "T"), status: status === "live" ? "live" : "review", form: JSON.stringify(FORM),
    submitted_at: AT, due_live_at: "2026-10-17T09:00:00Z", created_at: AT,
  });
  await insert(DB, "client_sites", {
    client_id: id, slug: `${id}-site-abc123`, place_id, host, content: JSON.stringify(CONTENT), status, domain: "{}",
    review_url: REVIEW, features, is_test, seen_at, live_at: status === "live" ? "2026-10-15T09:00:00Z" : null,
    content_at: "2026-10-14T09:00:00Z", created_at: AT, updated_at: AT,
  });
}

// A live site (Smith Roofing, chat on), a site in review, Workers AI connected and the chatbot offer switched on.
async function setup(opts = {}) {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "Smith Roofing", trade: LEAD.trade, search_town: "Swindon", maps_url: LEAD.maps_url,
    rating: LEAD.rating, review_count: LEAD.review_count, first_seen_at: AT, updated_at: AT,
  });
  await addClient(DB, { id: "c1", name: "Smith Roofing", host: HOST, status: "live", place_id: "p1", ...opts });
  await addClient(DB, { id: "c2", name: "Other Ltd", host: "www.other.co.uk", status: "review" });
  for (const [key, value] of [["secret:cf_ai:account_id", "acc123"], ["secret:cf_ai:token", "tok-secret-value"], ["offer:chatbot_live", "1"]]) {
    await insert(DB, "settings", { key, value });
  }
  return DB;
}

// serveClientHost with a context like Pages gives; waitUntil's promises are kept so a test can wait for them.
function client(DB, env = {}) {
  const waits = [];
  const call = (url, init) => serveClientHost({ request: new Request(url, init), env: { DB, ...env }, waitUntil: (p) => waits.push(p) }, NOW);
  return { call, settle: () => Promise.all(waits) };
}

// The middleware, as Pages runs it.
function gate(DB, env = { CONTROL_ROOM_PASSWORD: PASSWORD }) {
  const nexts = [];
  const next = async () => {
    nexts.push(true);
    return new Response("the Control Room", { status: 200 });
  };
  const call = (url, init) => onRequest({ request: new Request(url, init), env: { DB, ...env }, next, waitUntil: () => {} });
  return { call, nexts };
}

function assertSecurity(res, { html = true } = {}) {
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  if (html) assert.equal(res.headers.get("content-security-policy"), CLIENT_CSP);
  assert.equal(res.headers.get("set-cookie"), null);
}

test("the client-host CSP is section 7's, exactly", () => {
  assert.equal(CLIENT_CSP, "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' "
    + "'unsafe-inline'; frame-src https://maps.google.com https://www.google.com; form-action 'self'; base-uri 'none'");
});

test("home: 200 HTML with the home title, security headers, a 5-minute cache, and seen_at stamped", async () => {
  const DB = await setup();
  const { call, settle } = client(DB);
  const res = await call(`https://${HOST}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assertSecurity(res);
  const html = await res.text();
  assert.ok(html.includes("<title>Roofing contractor in Swindon | Smith Roofing – Roof repairs, flat roofs</title>"));
  assert.ok(html.includes(`<link rel="canonical" href="https://${HOST}/">`));
  assert.ok(!html.includes("noindex"));
  assert.ok(html.includes('<script src="/s/chat.js" defer></script>'), "chat is on: the widget tag");
  assert.ok(!html.includes("ae-bar"));
  await settle();
  assert.equal((await one(DB, "SELECT seen_at FROM client_sites WHERE client_id = 'c1'")).seen_at, "2026-10-28T10:00:00Z");
});

test("a page is one site read and one settings read (and the settings read never returns a secret into the page)", async () => {
  const DB = await setup({ seen_at: AT });
  const counted = countingDB(DB);
  const { call } = client(counted.DB);
  const res = await call(`https://${HOST}/services/roof-repairs`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("<h1"));
  assert.ok(!html.includes("tok-secret-value"));
  assert.ok(!html.includes("acc123"));
  assert.equal(counted.used(), 2);
});

test("http → 301 https on the same host and path", async () => {
  const { call } = client(await setup());
  const res = await call(`http://${HOST}/about?x=1`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `https://${HOST}/about?x=1`);
  const home = await call(`http://${HOST}/`);
  assert.equal(home.status, 301);
  assert.equal(home.headers.get("location"), `https://${HOST}/`);
  assertSecurity(home, { html: false });
});

test("the bare domain (the www twin) → 301 to the stored www host, same path and query", async () => {
  const { call } = client(await setup());
  const res = await call("https://smithroofing.co.uk/about");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `https://${HOST}/about`);
  const q = await call("https://smithroofing.co.uk/?a=b");
  assert.equal(q.headers.get("location"), `https://${HOST}/?a=b`);
});

test("a trailing slash → 301 to the path without it; never a //host redirect", async () => {
  const { call } = client(await setup());
  const res = await call(`https://${HOST}/about/`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/about");
  const many = await call(`https://${HOST}/services/roof-repairs//?a=1`);
  assert.equal(many.headers.get("location"), "/services/roof-repairs?a=1");
  const evil = await call(`https://${HOST}//evil.example/`);
  assert.equal(evil.status, 301);
  assert.ok(!evil.headers.get("location").startsWith("//"), evil.headers.get("location"));
  assert.equal(evil.headers.get("location"), "/evil.example");
});

test("an old path in redirects → 301 to its new page", async () => {
  const { call } = client(await setup());
  const res = await call(`https://${HOST}/roofing-services.html`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/services/roof-repairs");
  const other = await call(`https://${HOST}/contact-us.html`);
  assert.equal(other.headers.get("location"), "/contact");
  // Old sites often ignored case.
  const upper = await call(`https://${HOST}/Roofing-Services.html`);
  assert.equal(upper.status, 301);
  assert.equal(upper.headers.get("location"), "/services/roof-repairs");
});

test("/nope → 404, built by renderMissingPage: 'Sorry, that page isn't here.' and a link home", async () => {
  const { call } = client(await setup());
  const res = await call(`https://${HOST}/nope`);
  assert.equal(res.status, 404);
  assertSecurity(res);
  const html = await res.text();
  assert.ok(html.includes("Sorry, that page isn't here."));
  assert.ok(html.includes('<a href="/">Go to the home page</a>'));
  const expected = renderMissingPage(siteData(CONTENT, {
    lead: LEAD, host: HOST, base: "", reviewUrl: REVIEW, chat: true, noindex: false, form: FORM,
  }), { now: NOW });
  assert.equal(html, expected);
  // Unknown /s/ paths are the same 404 page.
  const s = await call(`https://${HOST}/s/nothing`);
  assert.equal(s.status, 404);
  assert.ok((await s.text()).includes("Sorry, that page isn't here."));
});

test("/sitemap.xml is XML, /robots.txt text, /privacy 200", async () => {
  const { call } = client(await setup());
  const sitemap = await call(`https://${HOST}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type"), /^application\/xml/);
  assertSecurity(sitemap, { html: false });
  const xml = await sitemap.text();
  for (const p of CONTENT.pages) assert.ok(xml.includes(`<loc>https://${HOST}${p.path}</loc>`), p.path);
  const robots = await call(`https://${HOST}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /^text\/plain/);
  assert.equal(await robots.text(), `User-agent: *\nAllow: /\nAllow: /s/f/\nDisallow: /s/\nSitemap: https://${HOST}/sitemap.xml\n`);
  const privacy = await call(`https://${HOST}/privacy`);
  assert.equal(privacy.status, 200);
  assertSecurity(privacy);
  assert.ok((await privacy.text()).includes("Website by Aetos Websites, which processes enquiries for Smith Roofing."));
});

test("a test site: noindex on its pages and robots.txt says Disallow: /", async () => {
  const { call } = client(await setup({ is_test: 1 }));
  const home = await (await call(`https://${HOST}/`)).text();
  assert.ok(home.includes('<meta name="robots" content="noindex">'));
  assert.equal(await (await call(`https://${HOST}/robots.txt`)).text(), "User-agent: *\nDisallow: /\n");
});

test("/s/review-card → 200 with the QR <svg>; 404 when review_booster is off or the package is Website Only", async () => {
  const { call } = client(await setup());
  const res = await call(`https://${HOST}/s/review-card`);
  assert.equal(res.status, 200);
  assertSecurity(res);
  const html = await res.text();
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("How did we do?"));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));

  const off = client(await setup({ features: JSON.stringify({ review_booster: false }) }));
  assert.equal((await off.call(`https://${HOST}/s/review-card`)).status, 404);
  const website = client(await setup({ pkg: "website" }));
  assert.equal((await website.call(`https://${HOST}/s/review-card`)).status, 404);
});

test("/s/chat.js → application/javascript; 404 when the chat is off (Website Only)", async () => {
  const { call } = client(await setup());
  const res = await call(`https://${HOST}/s/chat.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/javascript/);
  assertSecurity(res, { html: false });
  assert.ok((await res.text()).includes("Questions? Ask us"));
  const website = client(await setup({ pkg: "website" }));
  assert.equal((await website.call(`https://${HOST}/s/chat.js`)).status, 404);
  const page = await (await website.call(`https://${HOST}/`)).text();
  assert.ok(!page.includes("/s/chat.js"), "no chat tag when the chat is off");
});

test("POST /s/contact → 303 to /contact?sent=1, and the thanks page has no form", async () => {
  const DB = await setup();
  const { call } = client(DB);
  const res = await call(`https://${HOST}/s/contact`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" },
    body: new URLSearchParams({ name: "Dave", phone: "07700900123", message: "Leak", t: "5000", page: "/contact" }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/contact?sent=1");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM site_leads WHERE client_id = 'c1'")).n, 1);

  const thanks = await call(`https://${HOST}/contact?sent=1`);
  assert.equal(thanks.status, 200);
  const html = await thanks.text();
  assert.ok(html.includes("Thanks, Smith Roofing has your message and will be in touch soon."));
  assert.ok(!html.includes('id="cf"'), "no second form to send it again");
  // The plain contact page still has the form.
  assert.ok((await (await call(`https://${HOST}/contact`)).text()).includes('id="cf"'));
});

test("POST /s/chat reaches the chat endpoint (JSON, no cookie)", async () => {
  const { call } = client(await setup({ pkg: "website" })); // chat off: the fallback line, without calling Workers AI
  const res = await call(`https://${HOST}/s/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid: "abcdefghij0123456789", history: [], text: "Hi" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assertSecurity(res, { html: false });
  const body = await res.json();
  assert.equal(body.fallback, true);
  assert.equal(body.reply, "Leave your number and Smith Roofing will call you back.");
});

test("/s/f/<id> serves this client's file; another client's id is a 404", async () => {
  const DB = await setup();
  const png = Uint8Array.from(readFileSync(new URL("./fixtures/img/3x2.png", import.meta.url)));
  const id = "a".repeat(32);
  await insert(DB, "site_files", { id, client_id: "c1", kind: "photo", mime: "image/png", bytes: png, size: png.length, width: 3, height: 2, created_at: AT });
  await insert(DB, "site_files", { id: "b".repeat(32), client_id: "c2", kind: "photo", mime: "image/png", bytes: png, size: png.length, width: 3, height: 2, created_at: AT });
  const { call } = client(DB);
  const res = await call(`https://${HOST}/s/f/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assertSecurity(res, { html: false });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
  assert.equal((await call(`https://${HOST}/s/f/${"b".repeat(32)}`)).status, 404);
  assert.equal((await call(`https://${HOST}/s/f/${id}`, { method: "POST", body: "x" })).status, 405);
});

test("a site that isn't live → 404 'This website isn't set up yet.' (noindex), no redirects first", async () => {
  const DB = await setup();
  const { call, settle } = client(DB);
  const res = await call("https://www.other.co.uk/");
  assert.equal(res.status, 404);
  assertSecurity(res);
  const html = await res.text();
  assert.ok(html.includes("This website isn't set up yet."));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes("Other Ltd"));
  assert.equal((await call("http://other.co.uk/about/")).status, 404);
  await settle();
  assert.equal((await one(DB, "SELECT seen_at FROM client_sites WHERE client_id = 'c2'")).seen_at, null);
});

test("odd Host headers: upper case, :443, a trailing dot all serve the site; seen_at only on the canonical https host", async () => {
  const DB = await setup();
  const { call, settle } = client(DB);
  for (const url of ["https://WWW.SmithRoofing.co.uk/", `https://${HOST}:443/`, `https://${HOST}./`]) {
    const res = await call(url);
    assert.equal(res.status, 200, url);
  }
  const bare = await call("https://SMITHROOFING.co.uk./x");
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("location"), `https://${HOST}/x`);
  await settle();
  assert.equal((await one(DB, "SELECT seen_at FROM client_sites WHERE client_id = 'c1'")).seen_at, "2026-10-28T10:00:00Z");
});

test("redirects don't stamp seen_at; a site already seen isn't written again", async () => {
  const DB = await setup();
  const { call, settle } = client(DB);
  await call(`http://${HOST}/`);
  await call("https://smithroofing.co.uk/");
  await settle();
  assert.equal((await one(DB, "SELECT seen_at FROM client_sites WHERE client_id = 'c1'")).seen_at, null);

  const seen = await setup({ seen_at: AT });
  const counted = countingDB(seen);
  const c = client(counted.DB);
  await c.call(`https://${HOST}/robots.txt`);
  await c.settle();
  assert.equal(counted.used(), 1, "robots.txt: only the site read");
});

test("HEAD gives the status and headers with no body; other methods on a page are 405", async () => {
  const { call } = client(await setup());
  const head = await call(`https://${HOST}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await head.text(), "");
  const post = await call(`https://${HOST}/about`, { method: "POST", body: "x" });
  assert.equal(post.status, 405);
  assertSecurity(post, { html: false });
});

test("serveClientHost: null for a host with no client_sites row, for our own hosts and for /api/ (no D1 read)", async () => {
  const DB = await setup();
  const { call } = client(DB);
  assert.equal(await call("https://control.x/"), null);
  const counted = countingDB(DB);
  const c = client(counted.DB);
  assert.equal(await c.call("https://aetoswebsites.com/"), null);
  assert.equal(await c.call("https://goldbarwebsites.pages.dev/"), null);
  assert.equal(await c.call(`https://${HOST}/api/tick?reason=cron`), null);
  assert.equal(counted.used(), 0);
  // No database bound: not a client site as far as we can tell (the Control Room says what's wrong).
  assert.equal(await serveClientHost({ request: new Request(`https://${HOST}/`), env: {}, waitUntil() {} }, NOW), null);
});

test("a bad row on control.aetoswebsites.com never takes the Control Room offline: no lookup, the request reaches the gate", async () => {
  const DB = await setup();
  for (const [id, host, status] of [["c3", "www.control.aetoswebsites.com", "review"], ["c4", "control.aetoswebsites.com", "live"]]) {
    await addClient(DB, { id, name: `Bad ${id}`, host, status });
  }
  const counted = countingDB(DB);
  const c = client(counted.DB);
  for (const path of ["/login", "/", "/js/app.js", "/style.css"]) {
    assert.equal(await c.call(`https://control.aetoswebsites.com${path}`), null, path);
    assert.equal(await c.call(`https://www.control.aetoswebsites.com${path}`), null, path);
  }
  assert.equal(counted.used(), 0);
  const { call, nexts } = gate(DB);
  const login = await call("https://control.aetoswebsites.com/login");
  assert.equal(login.status, 200);
  assert.equal(await login.text(), "the Control Room");
  assert.equal(nexts.length, 1);
  // The test client's host is still looked up and served.
  await addClient(DB, { id: "c5", name: "Aetos Test Site", host: "site-test.aetoswebsites.com", status: "live", is_test: 1 });
  const res = await client(DB).call("https://site-test.aetoswebsites.com/");
  assert.equal(res?.status, 200);
});

test("middleware: a host with no row gets stage 0's routing: 303 /login without a cookie, the Control Room with one", async () => {
  const DB = await setup();
  const { call, nexts } = gate(DB);
  const res = await call("https://control.x/");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login");
  assert.equal(nexts.length, 0);
  const logged = await call("https://control.x/", { headers: { cookie: COOKIE } });
  assert.equal(logged.status, 200);
  assert.equal(await logged.text(), "the Control Room");
  assert.equal(nexts.length, 1);
});

test("middleware: *.pages.dev calls next() with no client_sites lookup", async () => {
  const DB = await setup();
  const counted = countingDB(DB);
  const { call, nexts } = gate(counted.DB);
  const res = await call("https://goldbarwebsites.pages.dev/", { headers: { cookie: COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(nexts.length, 1);
  assert.equal(counted.used(), 0);
});

test("middleware: the client host is served before the password check (works with CONTROL_ROOM_PASSWORD unset)", async () => {
  const DB = await setup();
  const { call, nexts } = gate(DB, {});
  const res = await call(`https://${HOST}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("Roofing contractor in Swindon"));
  assert.equal(nexts.length, 0);
  // The Control Room on another host still says the password is missing.
  assert.equal((await call("https://control.x/")).status, 500);
  // The client's /login is its own 404 page, not the Control Room's login.
  const login = await call(`https://${HOST}/login`);
  assert.equal(login.status, 404);
  assert.ok((await login.text()).includes("Sorry, that page isn't here."));
});

test("no client-host response sets a cookie", async () => {
  const DB = await setup();
  const { call } = gate(DB);
  const requests = [
    ["/"], ["/about"], ["/about/"], ["/nope"], ["/sitemap.xml"], ["/robots.txt"], ["/privacy"], ["/s/review-card"],
    ["/s/chat.js"], ["/roofing-services.html"], ["/contact?sent=1"],
    ["/s/contact", { method: "POST", body: new URLSearchParams({ website: "spam" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }],
  ];
  for (const [path, init] of requests) {
    for (const host of [HOST, "smithroofing.co.uk", "www.other.co.uk"]) {
      const res = await call(`https://${host}${path}`, init && { ...init });
      assert.equal(res.headers.get("set-cookie"), null, `${host}${path}`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${host}${path}`);
    }
  }
});

// ---- Reviewer additions (Task 22 review): Workers-shaped context, Part A §15 edge cases, the photo cache.

test("waitUntil is called as the context's method (a Workers context throws when it's called unbound)", async () => {
  const DB = await setup();
  const waits = [];
  const context = {
    request: new Request(`https://${HOST}/`),
    env: { DB },
    waitUntil(p) {
      if (this !== context) throw new TypeError("Illegal invocation");
      waits.push(p);
    },
  };
  const res = await serveClientHost(context, NOW);
  assert.equal(res.status, 200);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal((await one(DB, "SELECT seen_at FROM client_sites WHERE client_id = 'c1'")).seen_at, "2026-10-28T10:00:00Z");
});

test("a site Nik took offline (status off) is the 'isn't set up yet' page on every path", async () => {
  const { call } = client(await setup({ status: "off" }));
  for (const path of ["/", "/about", "/s/chat.js", "/s/review-card", "/sitemap.xml"]) {
    const res = await call(`https://${HOST}${path}`);
    assert.equal(res.status, 404, path);
    assert.ok((await res.text()).includes("This website isn't set up yet."), path);
  }
});

test("monthly plan cancelled: chat off on the next request, the site, contact form and review link stay", async () => {
  const DB = await setup({ seen_at: AT });
  await DB.prepare("UPDATE clients SET cancelled_on = '2026-10-27' WHERE id = 'c1'").run();
  const { call } = client(DB);
  const home = await (await call(`https://${HOST}/`)).text();
  assert.ok(!home.includes("/s/chat.js"), "no chat tag");
  assert.ok(home.includes('id="cf"'), "the contact form stays");
  assert.ok(home.includes(REVIEW.replace(/&/g, "&amp;")), "the review link stays");
  assert.equal((await call(`https://${HOST}/s/chat.js`)).status, 404);
  assert.equal((await call(`https://${HOST}/s/review-card`)).status, 200, "the review card stays until stage 11 switches it off");
});

test("a review containing <script> is escaped on the live page", async () => {
  const DB = await setup({ seen_at: AT });
  const bad = { ...CONTENT, reviews: [{ author: "Eve <b>", rating: 5, text: "Great job <script>alert(1)</script> & tidy" }, ...CONTENT.reviews] };
  await DB.prepare("UPDATE client_sites SET content = ? WHERE client_id = 'c1'").bind(JSON.stringify(bad)).run();
  const { call } = client(DB);
  for (const path of ["/", "/reviews"]) {
    const html = await (await call(`https://${HOST}${path}`)).text();
    assert.ok(!html.includes("<script>alert(1)"), path);
    assert.ok(!html.includes("Eve <b>"), path);
    if (path === "/reviews") assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), path);
  }
});

test("/contact?sent=1 is noindex with no canonical and no JSON-LD", async () => {
  const { call } = client(await setup({ seen_at: AT }));
  const html = await (await call(`https://${HOST}/contact?sent=1`)).text();
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(!html.includes("application/ld+json"));
  assert.ok(html.includes("<h1>Thanks for your message</h1>"));
});

test("/s/f/<id> goes through the Cache API keyed on the canonical host: a hit costs only the site read", async () => {
  const DB = await setup({ seen_at: AT });
  const png = Uint8Array.from(readFileSync(new URL("./fixtures/img/3x2.png", import.meta.url)));
  const id = "c".repeat(32);
  await insert(DB, "site_files", { id, client_id: "c1", kind: "photo", mime: "image/png", bytes: png, size: png.length, width: 3, height: 2, created_at: AT });
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async (key) => store.get(key)?.clone(), put: async (key, res) => { store.set(key, res); } } },
  });
  try {
    const counted = countingDB(DB);
    const { call, settle } = client(counted.DB);
    const first = await call(`https://${HOST}/s/f/${id}`);
    assert.equal(first.status, 200);
    await settle();
    assert.deepEqual([...store.keys()], [`https://${HOST}/s/f/${id}`]);
    assert.equal(counted.used(), 2, "a miss: the site read and the file read");
    const hit = await call(`https://${HOST}/s/f/${id}?x=1`);
    assert.equal(hit.status, 200);
    assertSecurity(hit, { html: false });
    assert.equal(hit.headers.get("content-security-policy"), "default-src 'none'");
    assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), png);
    assert.equal(counted.used(), 3, "a hit: only the site read");
    const head = await call(`https://${HOST}/s/f/${id}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    if (had) Object.defineProperty(globalThis, "caches", had);
    else delete globalThis.caches;
  }
});
