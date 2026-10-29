// The Sites list and the Site page's pure HTML (stage 10, docs/rebuild/09-build.md section 13, Part B Task 25):
// public/js/sitesview.js. sitesRows(list) draws GET /api/sites, siteView(detail) draws GET /api/sites/<client_id>
// (Task 24's JSON). sites.js puts them on the page and wires the buttons; it reads the page, so only its source is
// checked here. Everything typed by the client, scraped or written by Claude is escaped.
// Run: node --test control-room/tests/sites-page.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { siteView, sitesRows, ukToday } from "../public/js/sitesview.js";

const js = (name) => readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");

const EMPTY = "No client sites yet. When a client sends their onboarding form, their site appears here.";
const GBP_NOT_LIVE = "Tick this once the site is live: the day you tick it starts the 90 days.";

const row = (over = {}) => ({
  client_id: "c1", name: "Smith Roofing", status_label: "Ready to approve",
  countdown: { label: "Due live Sat 31 Oct · 3 days left", level: "grey" },
  host: "www.smithroofing.co.uk", live: false, enquiries_30d: 2, status: "review", package: "full", is_test: false,
  due_live_at: "2026-10-31T22:30:00.000Z", live_at: null, ...over,
});

const LINK = "https://search.google.com/local/writereview?placeid=ChIJ1";

function detail(over = {}) {
  return {
    client_id: "c1", slug: "smith-roofing-ab12", place_id: "ChIJ1", name: "Smith Roofing", package: "full",
    status: "review", label: "Ready to approve", countdown: { label: "Due live Sat 31 Oct · 3 days left", level: "grey" },
    host: "www.smithroofing.co.uk", host_check: null, seen_at: null, live_at: null, approved_at: null,
    submitted_at: "2026-10-24T22:30:00.000Z", due_live_at: "2026-10-31T22:30:00.000Z", change_notes: null,
    is_test: 0, features: {}, domain: { mode: "nameservers", domain: "smithroofing.co.uk" },
    has_content: true, preview_url: "/c/smith-roofing-ab12/", temp_url: null, mode: "nameservers", nameservers: [],
    gbp: { answer: "yes", invite_sent: true, invite_accepted: null, profile_created: null },
    pages: [
      { path: "/", title: "Roofer in Swindon | Smith Roofing", words: 420, preview: "/c/smith-roofing-ab12/" },
      { path: "/services/roof-repairs", title: "Roof repairs in Swindon", words: 380, preview: "/c/smith-roofing-ab12/services/roof-repairs" },
    ],
    steps: [
      { id: "zone", title: "Add smithroofing.co.uk to Cloudflare", detail: "Cloudflare dashboard → Add a domain", done_at: null, auto: false },
      { id: "ns_email", title: "Send Smith Roofing the nameserver steps", detail: "Press Send.", done_at: null, auto: false },
      { id: "ns_wait", title: "Wait for the nameservers to switch", detail: "Ticks itself.", done_at: null, auto: true },
      { id: "pages", title: "Connect smithroofing.co.uk to Smith Roofing's website", detail: "Custom domains", done_at: null, auto: false },
    ],
    chat: { on: true, reason: null, today: 3, month: 41, fallbacks_today: 1 },
    leads: [{ id: "l1", source: "form", name: "Jane", phone: "07700 900123", email: "jane@example.com", page: "/contact", message: "Leaking roof", created_at: "2026-10-27T10:05:00.000Z" }],
    files: [{ id: "a".repeat(32), kind: "photo", url: `/s/f/${"a".repeat(32)}`, mime: "image/webp", size: 120000, width: 1600, height: 1200, alt: "A new slate roof", source_url: null, created_at: "2026-10-25T10:00:00.000Z" }],
    form: {
      business: { name: "Smith Roofing", phone: "07700 900456", email: "hello@smithroofing.co.uk", address: "1 High St, Swindon", show_address: "yes", legal_line: "Smith Roofing Ltd", leads_email: "jobs@smithroofing.co.uk" },
      services: [{ name: "Roof repairs", on: true }, { name: "Gutters", on: false }],
      areas: ["Swindon", "Wroughton"], domain: { has: "yes", name: "smithroofing.co.uk", registrar: "GoDaddy", can_login: "yes", email_on_it: "no" },
      gbp: { has: "yes", invite_sent: true }, review_link: "", notes: "",
    },
    review: {
      url: LINK, qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', card_url: null,
      messages: {
        sms: `Hi {customer}, thanks for choosing Smith Roofing. If you have a minute, could you leave us a Google review? It really helps a small local business: ${LINK} Thanks, Mark`,
        email: { subject: "Thanks from Smith Roofing", body: `Hi {customer},\n\nThanks for choosing Smith Roofing.\n\n${LINK}\n\nThanks,\nMark` },
        reminder: `Hi {customer}, just a quick reminder in case you missed it: if you could leave Smith Roofing a Google review, it would mean a lot. ${LINK} No worries if not. Mark`,
      },
      booster: true,
    },
    last_errors: null,
    ...over,
  };
}

const APPROVE = /data-act="approve"[^>]*>Approve and put live</;

test("sitesview.js is pure: it loads in node with no page", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.match(js("sitesview.js"), /from "\.\/html\.js"/);
  assert.doesNotMatch(js("sitesview.js"), /from "\.\/lib\.js"/);
});

test("Sites list: empty state, red countdown, columns, escaping and links", () => {
  for (const empty of [[], null, undefined, "x"]) assert.ok(sitesRows(empty).includes(EMPTY), String(empty));
  const html = sitesRows([row({ countdown: { label: "Due live Thu 29 Oct · less than a day left", level: "red" } })]);
  assert.match(html, /class="[^"]*\bdue-red\b/);
  for (const col of ["Client", "Status", "Due", "Address", "Enquiries"]) assert.ok(html.includes(`>${col}<`), col);
  assert.match(html, /href="#\/site\/c1"/);
  assert.ok(html.includes("Ready to approve") && html.includes("www.smithroofing.co.uk"));
  assert.doesNotMatch(sitesRows([row()]), /due-red/);
  assert.match(sitesRows([row({ countdown: { label: "Live Fri 30 Oct · on time", level: "green" }, live: true })]), /due-green/);
  // ✓ only when live
  assert.ok(sitesRows([row({ live: true, status: "live" })]).includes("✓"));
  assert.ok(!sitesRows([row()]).includes("✓"));
  const evil = sitesRows([row({ name: "<img src=x onerror=alert(1)>", client_id: 'c"1', host: "<b>x</b>" })]);
  assert.ok(!evil.includes("<img") && !evil.includes("<b>") && evil.includes("&lt;img"));
  assert.match(evil, /href="#\/site\/c%221"/);
  assert.ok(sitesRows([row({ is_test: true })]).includes("Test"));
});

test("Site page: a lead's name with HTML is escaped (and every other lead field)", () => {
  const evil = "<img src=x>";
  const html = siteView(detail({ leads: [{ id: "l1", source: "chat", name: evil, phone: evil, email: evil, message: `<script>alert(1)</script>`, page: "/", created_at: "2026-10-27T10:05:00.000Z" }] }));
  assert.ok(html.includes("&lt;img src=x&gt;"));
  assert.ok(!html.includes("<img src=x>"));
  assert.ok(!html.includes("<script>"));
});

test("Site page: the Approve button exists only in review", () => {
  assert.match(siteView(detail()), APPROVE);
  for (const status of ["draft", "live", "off"]) {
    assert.doesNotMatch(siteView(detail({ status, label: "x" })), /data-act="approve"/, status);
    assert.doesNotMatch(siteView(detail({ status, label: "x" })), /Approve and put live/, status);
  }
});

test('Site page: "Open www.smithroofing.co.uk" shows only when the DNS check is ok and the site has never been opened', () => {
  const ok = { at: "2026-10-28T09:00:00.000Z", ok: true, detail: "www.smithroofing.co.uk points at us ✓", fails: 0 };
  const ready = siteView(detail({ status: "live", host_check: ok, seen_at: null }));
  assert.ok(ready.includes("Open www.smithroofing.co.uk"));
  assert.ok(ready.includes("DNS is ready. Open https://www.smithroofing.co.uk once to finish."));
  assert.match(ready, /href="https:\/\/www\.smithroofing\.co\.uk\/"[^>]*target="_blank"/);
  assert.ok(!siteView(detail({ status: "live", host_check: ok, seen_at: "2026-10-28T09:10:00.000Z" })).includes("Open www.smithroofing.co.uk"));
  const notYet = { ...ok, ok: false, detail: "Not yet: www.smithroofing.co.uk still points at 1.2.3.4 (their old host)" };
  const waiting = siteView(detail({ status: "live", host_check: notYet, seen_at: null }));
  assert.ok(!waiting.includes("Open www.smithroofing.co.uk"));
  assert.ok(waiting.includes("Not yet: www.smithroofing.co.uk still points at 1.2.3.4 (their old host)"));
  assert.ok(!siteView(detail({ host_check: null })).includes("Open www.smithroofing.co.uk"));
  // before Approve, opening the host shows "This website isn't set up yet." and finishes nothing: no Open button
  const review = siteView(detail({ status: "review", host_check: ok, seen_at: null }));
  assert.ok(!review.includes("Open www.smithroofing.co.uk") && !review.includes("Open https://"));
  assert.ok(review.includes("DNS is ready: the site goes public once you approve it."));
});

test("Site page: Website Only has no Review booster and no Chatbot On", () => {
  const full = siteView(detail());
  assert.ok(full.includes("Review booster"));
  assert.match(full, /data-chat-state="on"[^>]*>On</);
  const web = siteView(detail({
    package: "website",
    chat: { on: false, reason: "Website Only clients don't have the chat assistant.", today: 0, month: 0, fallbacks_today: 0 },
    review: { url: LINK, qr_svg: "", card_url: null, messages: null, booster: false },
    gbp: { answer: null, invite_sent: false, invite_accepted: null, profile_created: null },
  }));
  assert.ok(!web.includes("Review booster"));
  assert.doesNotMatch(web, /data-chat-state="on"/);
  assert.doesNotMatch(web, />On</);
  assert.ok(web.includes("Off: Website Only clients don&#39;t have the chat assistant."));
  assert.doesNotMatch(web, /data-feature="chatbot"/, "no chat switch for Website Only");
  // never "On" for Website Only, even if the answer said so
  const webOn = siteView(detail({ package: "website", chat: { on: true, reason: null, today: 0, month: 0, fallbacks_today: 0 } }));
  assert.doesNotMatch(webOn, /data-chat-state="on"/);
  assert.doesNotMatch(webOn, />On</);
  assert.ok(!webOn.includes("Review booster") && !webOn.includes("Google Business Profile"));
});

test('Site page: "Invite accepted" is disabled until the site is live', () => {
  const inviteBox = (html) => (html.match(/<input[^>]*data-gbp="invite_accepted"[^>]*>/) || [""])[0];
  const before = siteView(detail({ status: "live", live_at: null }));
  assert.match(inviteBox(before), /\bdisabled\b/);
  assert.ok(before.includes(GBP_NOT_LIVE));
  const live = siteView(detail({ status: "live", live_at: "2026-10-29T10:00:00.000Z" }));
  assert.ok(inviteBox(live));
  assert.doesNotMatch(inviteBox(live), /\bdisabled\b/);
  assert.ok(!live.includes(GBP_NOT_LIVE));
  assert.match(siteView(detail({ live_at: "2026-10-29T10:00:00.000Z", gbp: { answer: "yes", invite_sent: true, invite_accepted: "2026-10-29T11:00:00.000Z", profile_created: null } })), /data-gbp="invite_accepted"[^>]*\bchecked\b/);
  assert.match(before, /data-gbp="profile_created"/);
});

test("Site page: header, previews, buttons by status, steps, review kit, chat, photos, answers", () => {
  const html = siteView(detail());
  assert.ok(html.includes("Smith Roofing") && html.includes("Ready to approve") && html.includes("Due live Sat 31 Oct · 3 days left"));
  // a preview link per page, in a new tab, with its words
  assert.match(html, /href="\/c\/smith-roofing-ab12\/services\/roof-repairs"[^>]*target="_blank"/);
  assert.ok(html.includes("380"));
  // buttons: Ask Claude for changes (has content), Take offline; no Build again (has content), no Put back online
  assert.ok(html.includes("What should Claude change?") && html.includes("Send to Claude"));
  assert.match(html, /<summary[^>]*>Ask Claude for changes<\/summary>/);
  assert.match(html, /data-act="offline"/);
  assert.doesNotMatch(html, /data-act="rebuild"/);
  assert.doesNotMatch(html, /data-act="online"/);
  const draft = siteView(detail({ status: "draft", has_content: false, preview_url: null, pages: [] }));
  assert.match(draft, /data-act="rebuild"[^>]*>Build again</);
  assert.doesNotMatch(draft, /Send to Claude/);
  assert.doesNotMatch(siteView(detail({ status: "draft", has_content: false, pages: [], submitted_at: null })), /data-act="rebuild"/);
  assert.match(siteView(detail({ status: "off" })), /data-act="online"[^>]*>Put back online</);
  // temporary link only when approved (temp_url set)
  assert.ok(!html.includes("Open the temporary link"));
  assert.match(siteView(detail({ status: "live", temp_url: "/w/smith-roofing-ab12/" })), /href="\/w\/smith-roofing-ab12\/"[^>]*>Open the temporary link</);
  // domain: the address field, steps as checkboxes (auto ones disabled), nameserver fields, Send email, Check now
  assert.ok(html.includes("Type it like smithroofing.co.uk"));
  assert.match(html, /<input[^>]*data-step="zone"/);
  assert.match(html, /<input[^>]*data-step="ns_wait"[^>]*\bdisabled\b/);
  assert.match(html, /data-send-email="nameservers"/);
  assert.match(html, /name="ns1"/);
  assert.match(html, /data-act="check"[^>]*>Check now</);
  assert.doesNotMatch(siteView(detail({ mode: "cname", steps: [{ id: "cname_email", title: "t", detail: "d", done_at: null, auto: false }] })), /name="ns1"/);
  assert.match(siteView(detail({ mode: "cname", steps: [{ id: "cname_email", title: "t", detail: "d", done_at: null, auto: false }] })), /data-send-email="cname"/);
  assert.match(siteView(detail({ steps: [{ id: "zone", title: "t", detail: "d", done_at: "2026-10-25T10:00:00.000Z", auto: false }] })), /data-step="zone"[^>]*\bchecked\b/);
  // review kit: the link, the QR as an image (never raw markup), the three templates with Copy
  assert.ok(html.includes(`value="${LINK}"`));
  assert.match(html, /<img[^>]*src="data:image\/svg\+xml,/);
  assert.doesNotMatch(html, /<svg xmlns/);
  assert.equal((html.match(/data-copy="/g) || []).length, 3);
  assert.ok(html.includes("The printable card opens once the site is live."));
  assert.match(siteView(detail({ review: { ...detail().review, card_url: "https://www.smithroofing.co.uk/s/review-card" } })), /href="https:\/\/www\.smithroofing\.co\.uk\/s\/review-card"[^>]*>Open the printable card</);
  // chat numbers and switch
  assert.match(html, /data-feature="chatbot"[^>]*\bchecked\b/);
  assert.ok(html.includes("41"));
  assert.ok(siteView(detail({ chat: { on: false, reason: "The chat isn't connected on Setup yet.", today: 0, month: 0, fallbacks_today: 0 } })).includes("Off: The chat isn"));
  // photos: thumbnail with its alt, delete, add
  assert.match(html, new RegExp(`<img[^>]*src="/s/f/${"a".repeat(32)}"[^>]*alt="A new slate roof"`));
  assert.match(html, /data-del-photo="a{32}"/);
  assert.match(html, /type="file"[^>]*data-add-photos/);
  // their answers
  assert.ok(html.includes("Their answers") && html.includes("GoDaddy") && html.includes("Wroughton") && html.includes("Roof repairs"));
});

test("Site page: unsafe links are dropped and Claude's refusals are shown escaped", () => {
  const html = siteView(detail({
    pages: [{ path: "/x", title: "<b>t</b>", words: 1, preview: "javascript:alert(1)" }],
    temp_url: "javascript:alert(2)", status: "live",
    review: { ...detail().review, card_url: "javascript:alert(3)", qr_svg: "<script>alert(4)</script>" },
    files: [{ id: "x", url: "javascript:alert(5)", alt: "<b>", width: 1, height: 1 }],
    last_errors: ["<script>alert(6)</script> pages[0].title is too long"],
  }));
  assert.doesNotMatch(html, /javascript:/);
  assert.ok(!html.includes("<script>") && !html.includes("<b>t</b>") && html.includes("&lt;b&gt;t&lt;/b&gt;"));
  assert.ok(html.includes("Claude&#39;s last try was refused"));
});

test("Site page: enquiries show the first 120 characters; the booster switch off says what it does", () => {
  const long = "x".repeat(119) + "yz" + "q".repeat(50);
  const html = siteView(detail({ leads: [{ id: "l1", source: "form", name: "Jo", phone: "", email: "", message: long, created_at: "2026-10-27T10:05:00.000Z" }] }));
  assert.ok(html.includes("x".repeat(119) + "y<") && !html.includes("yz"));
  const off = siteView(detail({ features: { review_booster: false }, review: { ...detail().review, booster: false } }));
  assert.ok(off.includes("The printable review card is switched off for this client, and their emails don't mention it."));
  assert.match(off, /<input[^>]*data-feature="review_booster"(?![^>]*\bchecked\b)[^>]*>/);
  assert.match(siteView(detail()), /<input[^>]*data-feature="review_booster"[^>]*\bchecked\b/);
});

test("Site page: change notes in progress, test client flag", () => {
  assert.ok(siteView(detail({ status: "draft", change_notes: "Make the <phone> bigger", label: "Claude is making your changes" })).includes("Make the &lt;phone&gt; bigger"));
  assert.ok(siteView(detail({ is_test: 1 })).includes("Test"));
});

test("ukToday: the UK date, across midnight in summer time", () => {
  assert.equal(ukToday(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
  assert.equal(ukToday(new Date("2026-12-01T23:30:00Z")), "2026-12-01");
});

test("sites.js: the page wiring (source checks: it reads the page, so it isn't imported here)", () => {
  const src = js("sites.js");
  for (const fn of ["sitesPage", "sitePage", "shrinkImage"]) assert.match(src, new RegExp(`export (async )?function ${fn}\\b`), fn);
  assert.match(src, /shrinkImage\(file, maxWidth = 1600, quality = 0\.8\)/);
  assert.match(src, /toBlob\([^)]*"image\/webp"/);
  assert.match(src, /fillStyle = "#fff"/, "JPEG fallback gets a white background");
  assert.match(src, /from "\.\/sitesview\.js"/);
  // stage 11's access action for "Invite accepted", then the todo closes through the domain route
  assert.match(src, /\/api\/care\//);
  assert.match(src, /action: "access"/);
  assert.match(src, /\/photos/);
  assert.ok(src.includes("Put ${") && src.includes("site live? It goes public as soon as their domain points at us."));
  assert.ok(src.includes("site offline? Visitors will see 'This website isn't set up yet.'"));
  for (const route of ["approve", "changes", "rebuild", "status", "feature", "domain", "send-domain-email", "check"]) {
    assert.ok(src.includes(`/${route}`), route);
  }
});
