// The Voice page (#/voice, nav "Voice") (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 14):
// public/js/voice.js's pure parts. The banner (paused until all 9 follow-ups are approved), the live word count (the
// server's count, done again in the browser: words after the {greeting} line, each {placeholder} one), one card per
// follow-up ("Follow-up 3 · day 4", Draft / Approved 19 Oct, the checks, what they'll see, Save and Approve), and Your
// style (the "How much is it?" card until Nik writes his own price answer, the add form, his examples and rules, the
// first emails he sent, collapsed). Everything from the server is escaped. The page is in nav.js's NAV after
// Money and before Setup. voice.js touches no page when it loads (lib.js is loaded inside voicePage), so this file
// needs none; the server's own answers (Task 12's routes on fakeD1) are drawn too, so the two keep agreeing.
// Run: node --test control-room/tests/voice-ui.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DRAFTS, FOLLOWUP_DAYS as SERVER_DAYS, checkFollowup } from "../functions/_lib/followups.js";
import { wordCount } from "../functions/_lib/mail/rules.js";
import { db } from "../functions/_lib/util.js";
import { onRequestPost as addExample } from "../functions/api/voice/examples/index.js";
import { onRequestPost as approveFollowup } from "../functions/api/voice/followups/[step]/approve.js";
import { PRICE_SITUATION as SERVER_PRICE, onRequestGet as getVoice } from "../functions/api/voice/index.js";
import { icon } from "../public/js/html.js";
import {
  EMPTY, FOLLOWUP_DAYS, MAX_WORDS, PRICE_SITUATION, SAVED, SUGGESTIONS, approvedCount, canApprove, followupCardHtml,
  followupWords, followupsHtml, styleHtml, voiceBanner, voiceBannerHtml, voiceBodyHtml, wordsLabel,
} from "../public/js/voice.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// voice.js (and html.js) loaded above with no page at all.
const PURE = typeof globalThis.document === "undefined";

const NOW = new Date("2026-10-25T10:00:00Z"); // Sun 25 Oct 2026, 10:00 UK (GMT from today)
const XSS = `"><img src=x onerror=alert(1)>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
const count = (html, s) => html.split(s).length - 1;
// The text a person reads: tags dropped, entities decoded, spaces collapsed (none left before a full stop).
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ \./g, ".").trim();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const escaped = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// The <button …data-x…> tag in `html`.
const buttonTag = (html, hook) => html.match(new RegExp(`<button[^>]*\\b${hook}\\b[^>]*>`))?.[0] ?? "";

const SAMPLE_3 = "Hi Mark,\n\nMost people find a local business on their phone now, so the site I made for Green Leaf Landscapes is built for phones first.\n\nHave a look on yours:\nhttps://aetoswebsites.com/d/green-leaf-landscapes";
const tpl = (patch = {}) => ({
  step: 3, day_offset: 4, body: DRAFTS[3], status: "draft", approved_at: null, issues: [], preview: SAMPLE_3, ...patch,
});
const words = (n) => Array.from({ length: n }, () => "word").join(" ");

// ---------------------------------------------------------------- the spec's test (Task 14, Step 1)

test("banner and word label", () => {
  const t = (n) => Array.from({ length: 9 }, (_, i) => ({ status: i < n ? "approved" : "draft" }));
  assert.equal(voiceBanner(t(6)), "Follow-ups are paused until you approve all 9 (6 of 9 approved).");
  assert.equal(voiceBanner(t(9)), "All 9 approved. Follow-ups are on.");
  assert.equal(wordsLabel(DRAFTS[1]), "28 / 60 words");
});

// ---------------------------------------------------------------- loading without a page

test("pure: voice.js loads in node with no page, and imports nothing that touches one", () => {
  assert.equal(PURE, true);
  const src = read("../public/js/voice.js");
  assert.doesNotMatch(src, /^import[^;]*from "\.\/lib\.js"/m, "lib.js reads the page when it loads: only a dynamic import inside voicePage()");
  assert.match(src, /import\("\.\/lib\.js"\)/);
  assert.match(src, /^import \{[^}]*\besc\b[^}]*\} from "\.\/html\.js";$/m);
  assert.doesNotMatch(src, /(?:from |import\()"[^"]*functions\//, "the browser can't load functions/_lib: only public/ is served");
});

// ---------------------------------------------------------------- the word count is the server's

test("the word count matches checkFollowup's, for every draft and at the limit", () => {
  assert.deepEqual(FOLLOWUP_DAYS, SERVER_DAYS, "voice.js's copy of FOLLOWUP_DAYS has drifted from followups.js");
  assert.equal(MAX_WORDS, 60);
  for (let s = 1; s <= 9; s++) {
    const after = DRAFTS[s].slice(DRAFTS[s].indexOf("\n"));
    assert.equal(wordsLabel(DRAFTS[s]), `${wordCount(after)} / 60 words`, `step ${s}`);
    assert.ok(followupWords(DRAFTS[s]) <= 60, `step ${s} is under the limit`);
  }
  // {business} and {demo_link} are one word each: "{business} {demo_link}" is 2.
  assert.equal(wordsLabel("{greeting}\n\n{business} {demo_link}"), "2 / 60 words");
  // 60 words passes the server's check, 61 doesn't: the label says the same number.
  assert.equal(wordsLabel(`{greeting}\n\n${words(60)}`), "60 / 60 words");
  assert.ok(!checkFollowup(`{greeting}\n\n${words(60)}`).some((i) => i.startsWith("Too long")));
  assert.equal(wordsLabel(`{greeting}\n\n${words(61)}`), "61 / 60 words");
  assert.ok(checkFollowup(`{greeting}\n\n${words(61)}`).includes("Too long: 61 words. Keep it to 60."));
  // Without a {greeting} first line every word counts, as on the server.
  assert.equal(wordsLabel(`Hello ${words(60)}`), "61 / 60 words");
  assert.ok(checkFollowup(`Hello ${words(60)}`).includes("Too long: 61 words. Keep it to 60."));
  // Spaces after {greeting} (pasted from Word) and Windows line ends are fine; nothing to count is 0.
  assert.equal(wordsLabel("{greeting}  \r\n\r\nOne two"), "2 / 60 words");
  assert.equal(wordsLabel("{greeting}"), "0 / 60 words");
  assert.equal(wordsLabel(""), "0 / 60 words");
  assert.equal(wordsLabel(null), "0 / 60 words");
  assert.equal(wordsLabel(42), "0 / 60 words");
});

// ---------------------------------------------------------------- the banner

test("the banner counts approved steps; yellow while paused, green once all 9 are on", () => {
  const t = (n) => Array.from({ length: 9 }, (_, i) => ({ step: i + 1, status: i < n ? "approved" : "draft" }));
  assert.equal(voiceBanner(t(0)), "Follow-ups are paused until you approve all 9 (0 of 9 approved).");
  assert.equal(voiceBanner(t(8)), "Follow-ups are paused until you approve all 9 (8 of 9 approved).");
  assert.equal(voiceBanner([]), "Follow-ups are paused until you approve all 9 (0 of 9 approved).");
  assert.equal(voiceBanner(null), "Follow-ups are paused until you approve all 9 (0 of 9 approved).");
  assert.equal(voiceBanner([null, "approved", { status: "APPROVED" }]), "Follow-ups are paused until you approve all 9 (0 of 9 approved).");
  assert.equal(approvedCount(t(9)), 9);
  assert.match(voiceBannerHtml(t(6)), /^<p class="banner warn" data-voice-banner>/);
  assert.match(voiceBannerHtml(t(9)), /^<p class="banner ok" data-voice-banner>/);
  assert.equal(plain(voiceBannerHtml(t(9))), "All 9 approved. Follow-ups are on.");
});

// ---------------------------------------------------------------- a follow-up's card

test("a draft card: title, Draft, the words, the checks, what they'll see, Save off and Approve on", () => {
  const html = followupCardHtml(tpl(), { now: NOW });
  const text = plain(html);
  assert.match(html, /^<section class="card voice-card" data-step="3">/);
  assert.ok(text.includes("Follow-up 3 · day 4"));
  assert.match(html, /<span class="badge warn">Draft<\/span>/);
  assert.ok(text.includes(wordsLabel(DRAFTS[3])));
  // The wording is in the box exactly (the parser drops the line break that starts a textarea).
  assert.ok(html.includes(`data-body>\n${escaped(DRAFTS[3])}</textarea>`));
  assert.ok(text.includes("Passes every check."));
  assert.ok(text.includes("What they'll see"));
  assert.ok(html.includes(escaped(SAMPLE_3)));
  assert.ok(text.includes(`Your name, "Aetos Websites" and the "no thanks" line go under it, as on your first email.`));
  assert.match(buttonTag(html, "data-save"), /\bdisabled\b/, "Save waits for a change");
  assert.doesNotMatch(buttonTag(html, "data-approve"), /\bdisabled\b/);
  assert.equal(canApprove(tpl()), true);
});

test("an approved card: Approved 19 Oct (UK date, the year when it isn't this one) and Approve off", () => {
  const html = followupCardHtml(tpl({ status: "approved", approved_at: "2026-10-19T09:00:00Z" }), { now: NOW });
  assert.match(html, /<span class="badge good">Approved 19 Oct<\/span>/);
  assert.match(buttonTag(html, "data-approve"), /\bdisabled\b/);
  assert.equal(canApprove(tpl({ status: "approved" })), false);
  // 23:30 UTC on 18 Oct is 00:30 on 19 Oct in the UK (BST).
  assert.match(followupCardHtml(tpl({ status: "approved", approved_at: "2026-10-18T23:30:00Z" }), { now: NOW }), /Approved 19 Oct</);
  assert.match(followupCardHtml(tpl({ status: "approved", approved_at: "2025-10-19T09:00:00Z" }), { now: NOW }), /Approved 19 Oct 2025</);
  assert.match(followupCardHtml(tpl({ status: "approved", approved_at: "nonsense" }), { now: NOW }), /<span class="badge good">Approved<\/span>/);
});

test("a card whose checks fail: each problem in red, Approve off; over 60 words the count is red", () => {
  const issues = ['Don\'t say "SEO". Say "front page of Google" instead.', "Too long: 61 words. Keep it to 60."];
  const html = followupCardHtml(tpl({ body: `{greeting}\n\n${words(61)}`, issues }), { now: NOW });
  for (const issue of issues) assert.ok(html.includes(`<li class="bad">${escaped(issue)}</li>`));
  assert.ok(!plain(html).includes("Passes every check."));
  assert.match(buttonTag(html, "data-approve"), /\bdisabled\b/);
  assert.equal(canApprove(tpl({ issues })), false);
  assert.match(html, /<span data-words class="bad-text">61 \/ 60 words<\/span>/);
  assert.match(followupCardHtml(tpl({ body: "{greeting}\n\n" }), { now: NOW }), /<span data-words class="bad-text">0 \/ 60 words</);
  assert.match(followupCardHtml(tpl(), { now: NOW }), /<span data-words>/);
});

test("a card without a preview says why; a step that isn't 1 to 9 draws nothing; the day falls back to the schedule", () => {
  assert.ok(plain(followupCardHtml(tpl({ preview: null }), { now: NOW })).includes("No preview: fix the checks above."));
  for (const step of [0, 10, "3", 2.5, null]) assert.equal(followupCardHtml(tpl({ step })), "");
  assert.equal(followupCardHtml(null), "");
  assert.ok(plain(followupCardHtml(tpl({ step: 9, day_offset: "60<b>" }))).includes("Follow-up 9 · day 60"));
});

test("followupsHtml: the banner, then the cards in step order", () => {
  const list = Array.from({ length: 9 }, (_, i) => tpl({ step: 9 - i, day_offset: FOLLOWUP_DAYS[8 - i], body: DRAFTS[9 - i] }));
  const html = followupsHtml([...list, tpl({ step: 12 }), null], { now: NOW });
  assert.ok(html.startsWith('<p class="banner warn" data-voice-banner>'));
  const steps = [...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const days = [...plain(html).matchAll(/Follow-up \d · day (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(days, FOLLOWUP_DAYS);
});

// ---------------------------------------------------------------- your style

const own = (patch = {}) => ({ id: "e1", kind: "example", situation: "send me more info", body: "Sure, here it is.", source: "nik_written", created_at: "2026-10-20T10:00:00Z", ...patch });
const sent = (patch = {}) => ({ id: "sent:m1", kind: "example", situation: "first email", body: "Hi Mark,\n\nI made you a site.", source: "nik_sent", created_at: "2026-10-22T08:20:00Z", ...patch });

test("Your style with nothing yet: the How much is it? card, the add form, the empty line, no sent emails", () => {
  const html = styleHtml([], false, { now: NOW });
  const text = plain(html);
  assert.ok(text.includes("How much is it? Claude answers from your price list until you add your own reply here."));
  assert.match(html, /<section class="card voice-card highlight" data-price-card>/);
  assert.match(buttonTag(html, "data-write-price"), />$/);
  assert.ok(text.includes("Write it"));
  assert.ok(text.includes(EMPTY));
  assert.equal(EMPTY, "No examples yet. Add how you'd answer the questions you get most.");
  assert.ok(!text.includes("First emails you've sent"));
  // The add form: Type (Example reply / Rule), When with the four suggestions, Text, Add.
  assert.match(html, /<form data-add/);
  assert.match(html, /<option value="example">Example reply<\/option><option value="rule">Rule<\/option>/);
  assert.match(html, /<label for="v-when">When<\/label><input id="v-when"[^>]*data-when/);
  assert.match(html, /<label for="v-text">Text<\/label><textarea id="v-text"[^>]*data-text/);
  assert.deepEqual(SUGGESTIONS, ["they ask the price", "send me more info", "can we have a call", "they say they're busy"]);
  for (const s of SUGGESTIONS) assert.ok(html.includes(`data-suggest="${escaped(s)}">${escaped(s)}</button>`), s);
  assert.match(html, /<button type="submit" class="btn">Add<\/button>/);
  assert.match(html, /data-add-error hidden/);
  // Write it fills in the server's situation for the price answer (decision D-3).
  assert.equal(PRICE_SITUATION, SERVER_PRICE);
});

test("Your style with his examples, rules and sent first emails: each with Delete, the sent ones collapsed", () => {
  const list = [
    own(), own({ id: "r1", kind: "rule", situation: "always", body: "Never say SEO." }),
    sent(), sent({ id: "sent:m2", created_at: "2025-12-30T10:00:00Z" }),
  ];
  const html = styleHtml(list, true, { now: NOW });
  const text = plain(html);
  assert.doesNotMatch(html, /data-price-card/, "his own price answer hides the card");
  assert.ok(!text.includes(EMPTY));
  assert.ok(text.includes("Example reply When send me more info Delete Sure, here it is."));
  assert.ok(text.includes("Rule When always Delete Never say SEO."));
  for (const id of ["e1", "r1", "sent:m1", "sent:m2"]) assert.equal(count(html, `data-delete="${id}"`), 1, id);
  assert.match(html, /<details class="card voice-card" data-sent>\s*<summary>First emails you&#39;ve sent \(2\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/, "the sent first emails start collapsed");
  assert.ok(text.includes("Sent 22 Oct Delete Hi Mark, I made you a site."));
  assert.ok(text.includes("Sent 30 Dec 2025"));
  // His own come before the sent ones.
  assert.ok(html.indexOf('data-delete="r1"') < html.indexOf("<details"));
  // Sent first emails only: the empty line still shows, since he has written none of his own yet.
  assert.ok(plain(styleHtml([sent()], true, { now: NOW })).includes(EMPTY));
});

test("everything from the server is escaped", () => {
  const card = followupCardHtml(tpl({ body: `</textarea>${XSS}`, issues: [XSS], preview: `Hi ${XSS}`, day_offset: XSS }), { now: NOW });
  noRawHtml(card);
  assert.doesNotMatch(card, /<\/textarea>[^\n]*<\/textarea>/, "the wording can't close its box early");
  assert.equal(count(card, "</textarea>"), 1);
  const style = styleHtml([own({ id: XSS, situation: XSS, body: XSS, kind: XSS }), sent({ id: XSS, body: XSS, created_at: XSS })], false, { now: NOW });
  noRawHtml(style);
  assert.ok(style.includes(`data-delete="${escaped(XSS)}"`));
  noRawHtml(voiceBodyHtml({ templates: [tpl({ body: XSS })], examples: [own({ body: XSS })], has_price_reply: false }, { now: NOW }));
});

// ---------------------------------------------------------------- the server's answers, drawn (Task 12's routes)

await db({ DB: fakeD1() }); // db() checks the schema once per isolate
const ORIGIN = "https://control.example";
const ctx = (env, path, { method = "GET", body, params = {} } = {}) => ({
  request: new Request(`${ORIGIN}${path}`, body === undefined ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  env, params, now: NOW,
});
const getAnswer = async (env) => (await getVoice(ctx(env, "/api/voice"))).json();

test("GET /api/voice's answer: 9 draft cards with the sample preview, paused, the price card", async () => {
  const env = { DB: fakeD1() };
  // Stage 7's two voice seeds marked done, as if Nik had deleted them, so the empty list shows (voice-seed.test.mjs)
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('voice:seeded', '2026-10-01T09:00:00Z')").run();
  const data = await getAnswer(env);
  const html = voiceBodyHtml(data, { now: NOW });
  const text = plain(html);
  assert.ok(text.indexOf("Follow-up emails") < text.indexOf("Your style"));
  assert.ok(text.includes("Follow-ups are paused until you approve all 9 (0 of 9 approved)."));
  assert.equal(count(html, 'class="card voice-card" data-step='), 9);
  assert.equal(count(html, '<span class="badge warn">Draft</span>'), 9);
  for (const t of data.templates) {
    assert.ok(text.includes(`Follow-up ${t.step} · day ${FOLLOWUP_DAYS[t.step - 1]}`));
    assert.ok(text.includes(wordsLabel(t.body)));
    assert.ok(html.includes(escaped(t.preview)), `step ${t.step}'s preview`);
  }
  assert.equal(count(html, "Passes every check."), 9, "the 9 drafts pass the server's checks");
  assert.ok(text.includes("Hi Mark, In case my last email got buried: I made a new website for Green Leaf Landscapes"));
  assert.ok(text.includes("How much is it?"));
  assert.ok(text.includes(EMPTY));
});

test("after approving all 9 and adding his price answer: green, Approved, no price card, his example listed", async () => {
  const env = { DB: fakeD1() };
  for (let s = 1; s <= 9; s++) {
    const res = await approveFollowup(ctx(env, `/api/voice/followups/${s}/approve`, { method: "POST", params: { step: String(s) } }));
    assert.equal(res.status, 200);
  }
  const added = await addExample(ctx(env, "/api/voice/examples", {
    method: "POST", body: { kind: "example", situation: "They ask  the PRICE", body: "It's around £2,000 for the site." },
  }));
  assert.equal(added.status, 200);
  const html = voiceBodyHtml(await getAnswer(env), { now: NOW });
  const text = plain(html);
  assert.match(html, /<p class="banner ok" data-voice-banner>All 9 approved\. Follow-ups are on\.<\/p>/);
  assert.equal(count(html, '<span class="badge good">Approved 25 Oct</span>'), 9);
  assert.equal(count(html, "data-approve disabled"), 9);
  assert.doesNotMatch(html, /data-price-card/);
  assert.ok(text.includes("Example reply When They ask the PRICE Delete It's around £2,000 for the site."));
});

// ---------------------------------------------------------------- the nav, the toasts, the styles

test("Voice is in the nav, after Money and before Setup; app.js runs voicePage", async () => {
  const app = read("../public/js/app.js");
  assert.match(app, /^import \{ voicePage \} from "\.\/voice\.js";$/m);
  assert.match(app, /voice: \(\) => voicePage\(\)/);
  // file 11's nav.js holds the nav (tests/nav.test.mjs checks the whole order)
  const { NAV, routeFor } = await import("../public/js/nav.js");
  const routes = NAV.map((n) => n[0]);
  assert.equal(routes.indexOf("voice"), routes.indexOf("money") + 1);
  assert.ok(routes.indexOf("voice") < routes.indexOf("setup"));
  const [, label, name] = NAV.find((n) => n[0] === "voice");
  assert.equal(label, "Voice");
  assert.equal(routeFor("#/voice").page, "voice");
  assert.ok(name && icon(name) !== icon("no-such-icon"), `the icon "${name}" isn't in html.js ICONS`);
});

test("Save's toast is Part A's; the page has its styles", () => {
  assert.equal(SAVED, "Saved as a draft. Approve it to switch follow-ups back on.");
  const src = read("../public/js/voice.js");
  assert.match(src, /lib\.toast\(SAVED\)/);
  assert.match(src, /export async function voicePage\(\)/);
  assert.match(read("../public/style.css"), /^\.voice-card \{/m);
});

test("style.css: the checks list styles only lists, so Setup's Connections card and DNS rows keep their own look", () => {
  const css = read("../public/style.css");
  // Setup renders <div class="card checks"> and <div class="checks">: a later bare `.checks { padding: 0; gap: 4px }`
  // would take the card's 20px padding and the rows' 16px gap (same specificity, later wins).
  const bare = [...css.matchAll(/^\.checks \{([^}]*)\}/gm)].map((m) => m[1].trim());
  assert.deepEqual(bare, ["display: grid; gap: 16px;"], "only Setup's own .checks rule is unscoped");
  assert.match(css, /^ul\.checks \{[^}]*list-style: none;[^}]*padding: 0;/m);
  // The voice card's lists are <ul class="checks">, so they get the list look.
  assert.match(followupCardHtml(tpl(), { now: NOW }), /<ul class="checks"><li class="ok">/);
});

test("while the box differs from the saved wording, the card is marked changed and its checks and preview greyed", () => {
  const src = read("../public/js/voice.js");
  assert.match(src, /card\.classList\.toggle\("changed", changed\)/);
  assert.match(read("../public/style.css"), /\.voice-card\.changed \.checks, \.voice-card\.changed \.preview-mail \{ opacity: 0\.5; \}/);
  // A fresh card is drawn unchanged (the box holds the saved wording).
  assert.doesNotMatch(followupCardHtml(tpl(), { now: NOW }), /voice-card changed/);
});
