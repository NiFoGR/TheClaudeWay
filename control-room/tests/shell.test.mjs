// App shell (nav + routing) and the Setup page. Run: node --test control-room/tests/shell.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const js = (name) => new URL(`../public/js/${name}`, import.meta.url);
const read = (name) => readFileSync(js(name), "utf8");

test("app.js lists built pages only: no soon items, no Roadmap or Outreach routes", () => {
  const app = read("app.js");
  assert.doesNotMatch(app, /\bsoon\b/i);
  const routes = [...app.matchAll(/route: "([^"]*)"/g)].map((m) => m[1]);
  for (const gone of ["roadmap", "outreach"]) assert.ok(!routes.includes(gone), `app.js still has a ${gone} route`);
  assert.doesNotMatch(app, /\.\/(roadmap|outreach)\.js|#\/(roadmap|outreach)\b/);
  // Both pages are gone from the Control Room and kept in legacy/.
  for (const gone of ["roadmap.js", "outreach.js"]) {
    assert.ok(!existsSync(js(gone)), `public/js/${gone} should be deleted`);
    assert.ok(existsSync(new URL(`../../legacy/control-room/public/js/${gone}`, import.meta.url)), `legacy/ has no ${gone}`);
  }
});

// File 11 Task 11 deletes this test when it replaces PAGES with nav.js.
test("PAGES has stage 0's five routes", () => {
  const app = read("app.js");
  assert.match(app, /export const PAGES\s*=/, "app.js has no PAGES registry");
  const routes = [...app.matchAll(/route: "([^"]*)"/g)].map((m) => m[1]);
  for (const r of ["home", "leads", "scraper", "maprank", "money"]) assert.ok(routes.includes(r), `PAGES has no ${r} route`);
});

test("app.js shows the red banner while the business details are missing", () => {
  const app = read("app.js");
  assert.match(app, /\/api\/setup\/business/);
  assert.match(app, /banner-red/);
  assert.ok(app.includes("Your name and business address aren't on aetoswebsites.com yet. The law needs them: add them on"));
  assert.ok(app.includes("Setup → Business details"));
});

test("setup.js has every section and the D-2 text", () => {
  const setup = read("setup.js");
  for (const heading of ["Health", "Mailboxes", "Receiving replies", "Claude", "Business details"]) {
    assert.ok(setup.includes(heading), `setup.js has no "${heading}" section`);
  }
  assert.ok(setup.includes("Error 1102"));
  assert.match(setup, /export (async )?function setupPage\b/);
});

test("setup.js imports esc from ./lib.js", () => {
  assert.match(read("setup.js"), /import\s*\{[^}]*\besc\b[^}]*\}\s*from\s*["']\.\/lib\.js["']/);
});

// ---------------------------------------------------------------- the Setup page's pure parts (no browser)
// lib.js and money.js touch the page when they load, so give them just enough of one.
const stub = () => ({
  innerHTML: "", textContent: "", hidden: false, style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], append() {}, prepend() {}, before() {}, remove() {},
});
globalThis.document ??= { getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [], body: stub() };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
const setup = await import("../public/js/setup.js");

const NOW = new Date("2026-10-22T12:00:00Z");
const XSS = `"><img src=x onerror=alert(1)>`;
// Escaped, the attack is harmless text (&lt;img … onerror=…&gt;); raw, it would be a tag or a link.
const noRawHtml = (html) => {
  assert.doesNotMatch(html, /<img|<script|href="javascript:/i);
};

test("Health: one row per light, the fix only when amber or red, levels can't inject markup", () => {
  const html = setup.healthHtml({
    lights: [
      { name: "tick", level: "green", detail: "Heartbeat ran 2 min ago", fix: "GREEN-FIX" },
      { name: "relay", level: "red", detail: `Relay ${XSS}`, fix: `<script>alert(1)</script>` },
      { name: "mailboxes", level: "amber", detail: "No mailbox yet", fix: "Buy one Namecheap Private Email mailbox and add it on Setup → Mailboxes." },
      { name: "demo_light", level: "grey", detail: "Not in use", fix: "GREY-FIX" },
      { name: "odd", level: `red" onmouseover="alert(1)`, detail: "x", fix: "" },
    ],
  });
  assert.equal(html.match(/class="light /g).length, 5);
  for (const level of ["green", "amber", "red", "grey"]) assert.match(html, new RegExp(`class="light ${level}"`));
  assert.ok(html.includes("Heartbeat ran 2 min ago"));
  assert.ok(html.includes("Buy one Namecheap Private Email mailbox and add it on Setup → Mailboxes."));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("GREEN-FIX") && !html.includes("GREY-FIX"));
  assert.doesNotMatch(html, /onmouseover="/);
  noRawHtml(html);
  assert.match(setup.healthHtml({ error: "Database down <b>" }), /system lights: Database down &lt;b&gt;/);
});

test("Mailboxes: empty state, the columns, and every value escaped", () => {
  assert.ok(setup.mailboxesHtml({ mailboxes: [], business: {} }, NOW).includes(
    "No mailbox yet. Buy one Namecheap Private Email mailbox on aetoswebsites.com (Launch plan, not the trial), then add it here. Cold emails start 14 days after the date you bought it, to warm it up.",
  ));
  const html = setup.mailboxesHtml({
    business: { sender_name: `Nik ${XSS}` },
    test_to: "me@gmail.com",
    smtp_proof: { at: "2026-10-22T11:58:00Z", ok: false, ms: 0, mailbox_id: "m1", error: `Failed ${XSS}` },
    mailboxes: [
      { id: "m1", address: `nik${XSS}@aetoswebsites.com`, display_name: `<b>Nik</b>`, role: "cold", started_on: "2026-09-01", status: "active", paused_reason: null, has_password: true, cap_today: 5, sent_today: 3, smtp_host: "mail.privateemail.com" },
      { id: `m2${XSS}`, address: "sys@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-10-20", status: "paused", paused_reason: `2 emails bounced ${XSS}`, has_password: false, cap_today: 0, sent_today: 0 },
    ],
  }, NOW);
  for (const col of ["Address", "Name shown", "Role", "Started", "Today", "Status", "Password"]) assert.ok(html.includes(`>${col}<`), col);
  assert.ok(html.includes("3 of 5 sent"));
  assert.ok(html.includes("saved ✓") && html.includes("missing"));
  assert.ok(html.includes("Cold") && html.includes("System"));
  for (const b of ["Test login", "Send test email", "Pause", "Resume", "Edit"]) assert.ok(html.includes(`>${b}<`), b);
  assert.ok(html.includes("&lt;b&gt;Nik&lt;/b&gt;"));
  assert.ok(html.includes("Real-time logs"), "the CPU how-to sits under the table");
  noRawHtml(html);
});

test("Send test email: the result in plain English, Error 1102 is decision D-2", () => {
  assert.equal(setup.sendOutcome(200, JSON.stringify({ ok: true, ms: 1400 })).message,
    "Sent in 1.4 s. Check that inbox (and its spam folder). Then read the CPU time in Cloudflare: how ↓");
  assert.equal(setup.sendOutcome(503, "<!DOCTYPE html><title>Worker exceeded resource limits</title>Error 1102").message,
    "Cloudflare stopped this send because it used more computer time than the free plan allows (Error 1102). That's decision D-2: the $5/month Workers Paid plan fixes it. It may or may not have been sent: check the inbox.");
  assert.equal(setup.sendOutcome(200, JSON.stringify({ ok: false, ms: 0, error: "Save the mailbox password first." })).message,
    "Save the mailbox password first.");
  const other = setup.sendOutcome(500, "<html>oops</html>");
  assert.equal(other.ok, false);
  assert.match(other.message, /check the inbox/);
  assert.equal(setup.loginText({ ok: true, ms: 900 }, { smtp_host: "mail.privateemail.com" }), "Logged in to mail.privateemail.com in 0.9 s.");
  assert.equal(setup.loginText({ ok: false, ms: 0, error: "Save the mailbox password first." }, {}), "Save the mailbox password first.");
});

test("Send test email: a JSON answer is never read as Cloudflare's Error 1102 page", () => {
  // A failed send that took 1.102 s, with no error text: still the Control Room's answer, not decision D-2.
  const slow = setup.sendOutcome(200, JSON.stringify({ ok: false, ms: 1102 }));
  assert.equal(slow.ok, false);
  assert.ok(!slow.d2 && !slow.message.includes("1102"), slow.message);
  assert.match(slow.message, /check the inbox/);
  assert.doesNotMatch(setup.sendOutcome(200, JSON.stringify({ ok: false })).message, /HTTP 200 instead of a result/);
  // Only a non-JSON page that mentions 1102 is the D-2 message; other pages are a plain "answered HTTP N".
  assert.equal(setup.sendOutcome(503, "Error 1102").d2, true);
  assert.ok(!setup.sendOutcome(503, "<html>Service unavailable</html>").d2);
  assert.match(setup.sendOutcome(503, "<html>Service unavailable</html>").message, /HTTP 503/);
});

test("Mailboxes: the add form defaults to UK today, prefills the name, and warm-up starts 14 days after the start date", () => {
  // 23:30 UTC on 22 Oct is 00:30 on 23 Oct in the UK (BST): today, and the latest date allowed, are the 23rd.
  const late = new Date("2026-10-22T23:30:00Z");
  const html = setup.mailboxesHtml({
    business: { sender_name: "Nik" },
    mailboxes: [{ id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-10-23", status: "active", cap_override: null, has_password: true, cap_today: 0, sent_today: 0 }],
  }, late);
  assert.match(html, /id="mb-started"[^>]*value="2026-10-23"/);
  assert.match(html, /id="mb-started"[^>]*max="2026-10-23"/);
  assert.match(html, /id="mb-name"[^>]*value="Nik"/);
  assert.ok(html.includes("0 of 0 sent"));
  assert.ok(html.includes("warming up: cold emails from 6 Nov"), "day 14 is the first day with a cold-send cap");
  assert.doesNotMatch(html, /id="mb-password"[^>]*value=/, "the password field is write-only");
  // A cap set by hand replaces the warm-up, so no warm-up note.
  const capped = setup.mailboxesHtml({ mailboxes: [{ id: "m1", address: "a@b.co", display_name: "Nik", role: "cold", started_on: "2026-10-23", status: "active", cap_override: 5, has_password: true, cap_today: 5, sent_today: 1 }] }, late);
  assert.ok(capped.includes("1 of 5 sent") && !capped.includes("warming up"));
});

test("since(): whole minutes, hours or days, rounded down", () => {
  const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  assert.equal(setup.since(at(0.5), NOW), "just now");
  assert.equal(setup.since(at(59), NOW), "59 min ago");
  assert.equal(setup.since(at(60), NOW), "1 h ago");
  assert.equal(setup.since(at(24 * 60 - 1), NOW), "23 h ago");
  assert.equal(setup.since(at(24 * 60), NOW), "1 day ago");
  assert.equal(setup.since(at(49 * 60), NOW), "2 days ago");
  assert.equal(setup.since("not a time", NOW), null);
  // An unreadable time never prints "null" in a status line.
  assert.doesNotMatch(setup.receivingHtml({ relay_last_at: "garbage", last_inbound_at: "garbage" }, NOW), /null|undefined/);
});

test("Claude: the Routine fields are write-only, and Test fire waits until it's connected", () => {
  const html = setup.claudeHtml({
    agent_token: { set: false },
    routines: [{ name: "research", label: "Research", connected: false, last_beat: null, last_fire: null }],
  }, NOW);
  assert.doesNotMatch(html, /name="(url|token)"[^>]*value=/);
  assert.match(html, /data-test-fire="research" disabled/);
  assert.ok(html.includes("Not connected") && html.includes("Hasn&#39;t run yet") && html.includes("Last fire: none yet"));
  assert.ok(!html.includes("saved ✓ ("), "no access key yet");
});

test("Health: what's still to set up is counted and listed", () => {
  const two = setup.healthHtml({ lights: [], gaps: [{ key: "agent_token", title: "Make Claude's access key", detail: "Press Generate" }, { key: "business", title: "Add your name and business address", detail: "x" }] });
  assert.ok(two.includes("Still to set up: 2 things"));
  assert.ok(two.includes("Make Claude&#39;s access key"));
  assert.ok(setup.healthHtml({ lights: [], gaps: [{ key: "business", title: "t", detail: "d" }] }).includes("Still to set up: 1 thing<"));
  assert.ok(!setup.healthHtml({ lights: [], gaps: [] }).includes("Still to set up"));
});

test("DNS: ✓/✕ rows, the record to add for each ✕, the MX line, all escaped", () => {
  const html = setup.dnsHtml("aetoswebsites.com", {
    at: "2026-10-22T11:50:00Z", ok: false, mx_note: `Mail to aetoswebsites.com goes to Cloudflare Email Routing ${XSS}`,
    checks: [
      { name: "SPF", ok: false, found: `v=spf1 ${XSS} ~all`, fix: `In Cloudflare ${XSS}`, record: { type: "TXT", name: "@", content: "v=spf1 include:spf.privateemail.com include:_spf.mx.cloudflare.net ~all" } },
      { name: "DKIM", ok: true, found: "v=DKIM1; p=AAA", fix: "", record: { type: "TXT", name: "privateemail._domainkey", content: "x" } },
      { name: "DMARC", ok: false, found: "", fix: "Add it", record: { type: "TXT", name: "_dmarc", content: `v=DMARC1; p=none; rua=mailto:${XSS}` } },
    ],
  }, NOW);
  assert.ok(html.includes("DNS for aetoswebsites.com"));
  assert.ok(html.includes("✓") && html.includes("✕"));
  assert.ok(html.includes("v=spf1 include:spf.privateemail.com include:_spf.mx.cloudflare.net ~all"));
  assert.ok(html.includes("_dmarc"));
  assert.ok(html.includes("Mail to aetoswebsites.com goes to Cloudflare Email Routing"));
  assert.ok(html.includes(">Check again<"));
  noRawHtml(html);
  assert.ok(setup.dnsHtml("x.co.uk", { at: null, ok: false, checks: [], mx_note: null }, NOW).includes(">Check again<"));
});

test("Receiving replies: the status lines and both D-1 options", () => {
  const html = setup.receivingHtml({ relay_last_at: "2026-10-22T11:57:00Z", last_inbound_at: null }, NOW);
  assert.ok(html.includes("Mail relay checked in 3 min ago"));
  assert.ok(html.includes("Last email received: none yet"));
  assert.ok(html.includes("Option A, a receive-only domain (recommended: Namecheap stays your real inbox)"));
  assert.ok(html.includes("Option B, Cloudflare receives aetoswebsites.com"));
  assert.ok(html.includes("aetos-mail-relay"));
  assert.ok(setup.receivingHtml({ relay_last_at: null, last_inbound_at: "2026-10-22T11:59:40Z" }, NOW).includes("Last email received: just now"));
});

test("Receiving replies: a relay that checks in but can't reach the Control Room says why, escaped", () => {
  const detail = `tick call failed: cron: HTTP 530 (error 1042: set CONTROL_ROOM_URL to the project's *.pages.dev address) ${XSS}`;
  const html = setup.receivingHtml({ relay_last_at: "2026-10-22T11:59:00Z", relay_ok: false, relay_detail: detail, last_inbound_at: null }, NOW);
  assert.ok(html.includes("Mail relay checked in 1 min ago"));
  assert.ok(html.includes("tick call failed: cron: HTTP 530 (error 1042: set CONTROL_ROOM_URL to the project&#39;s *.pages.dev address)"));
  noRawHtml(html);
  // A relay that's fine shows no problem line, even with a detail.
  const ok = setup.receivingHtml({ relay_last_at: "2026-10-22T11:59:00Z", relay_ok: true, relay_detail: "cron and health ticks called", last_inbound_at: null }, NOW);
  assert.ok(!ok.includes("cron and health ticks called"));
});

test("Claude: access key and one row per Routine, never a secret, errors escaped", () => {
  const html = setup.claudeHtml({
    agent_token: { set: true, created_at: "2026-10-19T09:00:00Z" },
    routines: [
      { name: "research", label: "Research", connected: true, last_beat: { at: "2026-10-22T11:59:30Z", ok: true, detail: "" }, last_fire: { at: "2026-10-22T11:00:00Z", ok: false, http_status: 401, error: `Claude rejected the token ${XSS}`, session_url: "javascript:alert(1)" } },
      { name: "reply", label: "Replies", connected: false, last_beat: null, last_fire: null },
    ],
  }, NOW);
  assert.ok(html.includes("saved ✓ (made 19 Oct)"));
  assert.ok(html.includes(">Replace<"));
  assert.ok(html.includes("Research") && html.includes("Replies"));
  assert.ok(html.includes("Connected") && html.includes("Not connected"));
  assert.ok(html.includes("Last ran just now"));
  assert.ok(html.includes("Last fire: Claude rejected the token"));
  for (const b of ["Save", "Test fire"]) assert.ok(html.includes(`>${b}<`), b);
  noRawHtml(html);
  assert.ok(setup.claudeHtml({ agent_token: { set: false }, routines: [] }, NOW).includes(">Generate<"));
  assert.ok(setup.TOKEN_ONCE.startsWith("Copy it now: it won't be shown again."));
  // the network secret is set up in routines/README.md's section 1 (## 1. The shared "Aetos" environment)
  assert.ok(setup.TOKEN_ONCE.includes("(routines/README.md, section 1)"), setup.TOKEN_ONCE);
});

test("Business details: the fields, saved values escaped into the form", () => {
  const html = setup.businessHtml({ sender_name: "Nik", legal_name: XSS, address: `1 St <b>`, contact_email: "hello@aetoswebsites.com", ico_number: "" });
  assert.ok(html.includes("Business details"));
  assert.ok(html.includes(">Check aetoswebsites.com<"));
  assert.ok(html.includes("hello@aetoswebsites.com"));
  assert.ok(html.includes("1 St &lt;b&gt;"));
  noRawHtml(html);
});
