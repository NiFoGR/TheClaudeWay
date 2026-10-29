// Stage 8 call page (#/call/<id>) and the call box in the lead drawer / thread view (docs/rebuild/07-replies-calls.md
// Part A "Call page" and "Lead drawer", Part B Task 16): the pure renderers in public/js/call.js (callPageHtml,
// callBoxHtml) and the wiring in leads.js (app.js's route is in tests/nav.test.mjs). call.js touches no page when it loads (lib.js is loaded inside
// the entry points), so this file needs none.
// Run: node --test control-room/tests/call-page.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { offerFor, GUARANTEE } from "../functions/_lib/offer.js";
import { callBoxHtml, callIdFrom, callPageHtml, orderMessage } from "../public/js/call.js";

const WEEKDAY_OFFER = { ...offerFor(new Date("2026-10-20T10:00:00Z")), guarantee: GUARANTEE };   // Tue
const WEEKEND_OFFER = { ...offerFor(new Date("2026-10-24T10:00:00Z")), guarantee: GUARANTEE };   // Sat
const js = (name) => readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");

test("the call page: who, when, tap to call, the script at the call day's prices, the outcomes, escaped", () => {
  const data = { call: { id: "c1", status: "confirmed", phone: "07700 900123" }, label: "Tuesday 20 October at 11am", after_slot: true,
    lead: { name: "DIAMOND KICKBOXING LTD", owner_first: "Mark" }, offer: WEEKDAY_OFFER, thread_link: "/#/replies/p1" };
  const html = callPageHtml(data);
  assert.match(html, /Tuesday 20 October at 11am/); assert.match(html, /href="tel:07700900123"/);
  assert.match(html, /Mark/); assert.match(html, /£1,950/); assert.match(html, /Top 3 in Google search results in 90 days\. GUARANTEED\./);
  assert.match(callPageHtml({ ...data, offer: WEEKEND_OFFER }), /£1,750/);
  for (const b of ["Done", "No answer", "They're ordering: send the order link", "Not for them"]) assert.match(html, new RegExp(b));
  assert.match(callPageHtml({ ...data, after_slot: false }), /Cancel call/);
  assert.doesNotMatch(callPageHtml({ ...data, lead: { ...data.lead, name: "<img src=x onerror=alert(1)>" } }), /<img src=x/);
});

const BASE = {
  call: { id: "c1", place_id: "p1", status: "confirmed", phone: "07700 900123", slot_at: "2026-10-20T10:00:00Z" },
  label: "Tuesday 20 October at 11am", after_slot: true,
  lead: { place_id: "p1", name: "DIAMOND KICKBOXING LTD", owner_first: "Mark", phone: "01925 111222" },
  links: { demo: "https://aetoswebsites.com/d/diamond", order: "https://aetoswebsites.com/d/diamond/order" },
  offer: WEEKDAY_OFFER, thread_link: "/#/replies/p1",
};

test("the call page's copy as Part A writes it", () => {
  const html = callPageHtml(BASE);
  assert.match(html, /Call Mark · Diamond Kickboxing/);
  assert.match(html, /Open the email thread/);
  assert.match(html, /href="\/#\/replies\/p1"/);
  assert.match(html, /How did it go\?/);
  assert.doesNotMatch(html, /Cancel call/);   // after the slot: the outcomes, not Cancel
  // The order link message, editable, pre-filled with the latest demo's order page.
  assert.equal(orderMessage(BASE.links.order), "Great speaking to you. Here's the link to get started:\n\nhttps://aetoswebsites.com/d/diamond/order");
  assert.match(html, /Great speaking to you\. Here&#39;s the link to get started:\n\nhttps:\/\/aetoswebsites\.com\/d\/diamond\/order<\/textarea>/);
  const before = callPageHtml({ ...BASE, after_slot: false });
  assert.match(before, /Cancel call/);
  assert.doesNotMatch(before, /How did it go\?|Not for them/);
  // No name known: the business alone; the call's own day decides the script's month (October).
  const noName = callPageHtml({ ...BASE, lead: { ...BASE.lead, owner_first: null } });
  assert.match(noName, /Call Diamond Kickboxing</);
  assert.match(noName, /this October/);
});

test("the call page: phone from the lead when the call has none, none at all says so; a closed call has no buttons", () => {
  assert.match(callPageHtml({ ...BASE, call: { ...BASE.call, phone: null } }), /href="tel:01925111222"/);
  const none = callPageHtml({ ...BASE, call: { ...BASE.call, phone: null }, lead: { ...BASE.lead, phone: null } });
  assert.doesNotMatch(none, /href="tel:/);
  assert.match(none, /No phone number yet/);
  for (const [status, words] of [["done", /This call is done\./], ["no_show", /no answer/i], ["cancelled", /This call was cancelled\./]]) {
    const html = callPageHtml({ ...BASE, call: { ...BASE.call, status } });
    assert.match(html, words);
    assert.doesNotMatch(html, /data-action=/);
  }
  // No demo yet: no order link to send, and the page says why instead of sending an empty link.
  const noDemo = callPageHtml({ ...BASE, links: { demo: null, order: null } });
  assert.match(noDemo, /no order link yet/i);
  assert.doesNotMatch(noDemo, /data-action="ordering"/);
});

test("the call page escapes everything it's given and only links safe places", () => {
  const XSS = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
  const html = callPageHtml({
    ...BASE,
    label: XSS,
    call: { ...BASE.call, id: XSS, phone: XSS },
    lead: { ...BASE.lead, name: XSS, owner_first: XSS, town: XSS, trade: XSS },
    links: { demo: "javascript:alert(1)", order: "javascript:alert(1)" },
    thread_link: "javascript:alert(1)",
  });
  assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
  assert.doesNotMatch(html, /javascript:alert/);
  // A thread link that isn't the app's own is rebuilt from the lead's place_id.
  assert.match(html, /href="\/#\/replies\/p1"/);
  // A page with nothing readable still renders (the API's error is shown by callPage).
  assert.doesNotThrow(() => callPageHtml({}));
  assert.doesNotThrow(() => callPageHtml(null));
});

test("callIdFrom reads #/call/<id>", () => {
  assert.equal(callIdFrom("#/call/c1"), "c1");
  assert.equal(callIdFrom("#/call/a%2Fb"), "a/b");
  assert.equal(callIdFrom("#/call"), null);
  assert.equal(callIdFrom("#/call/%E0"), null);
});

const FREE = [
  { slot_at: "2026-10-23T10:00:00Z", label: "Friday 23 October at 11am" },
  { slot_at: "2026-10-24T10:00:00Z", label: "Saturday 24 October at 11am" },
  { slot_at: "2026-10-25T11:00:00Z", label: "Sunday 25 October at 11am" },
];

test("the call box: Booked + Cancel, or Book a call with the next 3 free slots, another time, phone, Book", () => {
  const BOOKED = { calls: [{ id: "c1", status: "confirmed", slot_at: "2026-10-23T10:00:00Z", label: "Friday 23 October at 11am" }], free_slots: FREE, phone: "07700 900123" };
  const booked = callBoxHtml(BOOKED, "p1", { now: new Date("2026-10-21T09:00:00Z") });
  assert.match(booked, /Booked: Friday 23 October at 11am/);
  assert.match(booked, /data-cancel="c1"/);
  assert.match(booked, />Cancel</);
  assert.match(booked, /href="#\/call\/c1"/);
  assert.doesNotMatch(booked, /Book a call:/);
  // From the call's time on it happened (or didn't): no Cancel, the call page's How did it go? instead.
  const past = callBoxHtml(BOOKED, "p1", { now: new Date("2026-10-23T10:00:00Z") });
  assert.match(past, /Booked: Friday 23 October at 11am/);
  assert.doesNotMatch(past, /data-cancel=/);
  assert.match(past, /href="#\/call\/c1">How did it go\? Open the call page</);

  // Booking cancels their other calls still ahead but keeps one whose time has passed (for its outcome): the box shows
  // the one ahead, whatever order the API lists them in, and the past one still waiting for its outcome lets Nik book.
  const PAST = { id: "c0", status: "confirmed", slot_at: "2026-10-16T10:00:00Z", label: "Friday 16 October at 11am" };
  for (const calls of [[BOOKED.calls[0], PAST], [PAST, BOOKED.calls[0]]]) {
    const two = callBoxHtml({ ...BOOKED, calls }, "p1", { now: new Date("2026-10-21T09:00:00Z") });
    assert.match(two, /Booked: Friday 23 October at 11am/);
    assert.match(two, /data-cancel="c1"/);
    assert.doesNotMatch(two, /16 October|data-cancel="c0"/);
  }
  const waiting = callBoxHtml({ ...BOOKED, calls: [PAST] }, "p1", { now: new Date("2026-10-21T09:00:00Z") });
  assert.match(waiting, /href="#\/call\/c0">How did it go\? Open the call page</);
  assert.doesNotMatch(waiting, /data-cancel=/);
  assert.match(waiting, /Book a call:/);
  assert.match(waiting, /or another time/);

  const free = callBoxHtml({ calls: [{ id: "c0", status: "done", slot_at: "2026-10-13T10:00:00Z", label: "Tuesday 13 October at 11am" }], free_slots: FREE, phone: "07700 900123" }, "p1");
  assert.match(free, /Book a call:/);
  for (const s of FREE) assert.match(free, new RegExp(`<option value="${s.slot_at}">${s.label}</option>`));
  assert.match(free, /or another time/);
  assert.match(free, /type="date"/); assert.match(free, /type="time"/);
  assert.match(free, /type="tel"[^>]*value="07700 900123"/);
  assert.match(free, />Book</);
  assert.doesNotMatch(free, /Booked:/);

  // No free slot in 8 weeks: another time is still there.
  const full = callBoxHtml({ calls: [], free_slots: [], phone: null }, "p1");
  assert.match(full, /No free call slots in the next 8 weeks/);
  assert.match(full, /or another time/);

  // Claude has offered a time and they haven't confirmed: shown, and Nik can still book.
  const offered = callBoxHtml({ calls: [{ id: "c2", status: "offered", slot_at: "2026-10-23T10:00:00Z", label: "Friday 23 October at 11am" }], free_slots: FREE, phone: null }, "p1");
  assert.match(offered, /Offered: Friday 23 October at 11am/);
  assert.match(offered, /Book a call:/);

  const XSS = `"><img src=x onerror=alert(1)>`;
  const bad = callBoxHtml({ calls: [{ id: XSS, status: "confirmed", label: XSS }], free_slots: [{ slot_at: XSS, label: XSS }], phone: XSS }, XSS);
  assert.doesNotMatch(bad, /<img/);
  assert.doesNotMatch(callBoxHtml({ calls: [], free_slots: [{ slot_at: XSS, label: XSS }], phone: XSS }, XSS), /<img/);
  assert.doesNotThrow(() => callBoxHtml(null, ""));
});

test("wiring: the drawer mounts the call box in #d-call; the page posts each outcome to /api/calls/:id", () => {
  const leads = js("leads.js");
  assert.match(leads, /import\("\.\/call\.js"\)/);
  assert.match(leads, /renderCallBox\(/);
  assert.match(leads, /#d-call|"d-call"/);
  const call = js("call.js");
  assert.doesNotMatch(call, /^import [^;]*from "\.\/lib\.js"/m);   // loaded on first use: node tests need no page
  assert.match(call, /\/api\/calls\/\$\{encodeURIComponent\(/);
  assert.match(call, /\/api\/calls\?place_id=\$\{encodeURIComponent\(/);
  for (const action of ["cancel", "done", "no_show", "ordering", "lost"]) assert.match(call, new RegExp(`"${action}"`));
  // app.js imports callPage and runs it for #/call/<id> (tests/nav.test.mjs checks the route and the nav).
  assert.match(js("app.js"), /import \{[^}]*\bcallPage\b[^}]*\} from "\.\/call\.js"/);
});
