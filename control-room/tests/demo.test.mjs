// Demo sites. Run: node --test control-room/tests/demo.test.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCHEMA } from "../functions/_lib/schema.js";
import { isWeekendUK, renderDemo, renderExpired, renderOrder, servicesFor, slugFor } from "../functions/_lib/demo.js";
import { ensureDemo, recordEvent } from "../functions/_lib/demo-db.js";
import { BUILD_GUARANTEE, GUARANTEE } from "../functions/_lib/offer.js";
import { onRequestPost as enrol } from "../functions/api/outreach/enrol.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    _run: () => db.prepare(sql).run(...args),
  });
  SCHEMA.forEach((s) => db.exec(s));
  return { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => s._run()), raw: db };
}

const LEAD = { place_id: "p1", name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "Kickboxing", town: "Warrington",
  phone: "07969 770905", rating: 4.7, review_count: 12 };
const DEMO = { slug: "diamond-kickboxing-academy-abc234", expires_at: "2026-10-18T12:00:00Z" };

test("the demo shows their real details, escaped, with one button to the order page", () => {
  const html = renderDemo(LEAD, DEMO);
  assert.match(html, /Diamond Kickboxing Academy/);
  assert.match(html, /4\.7<\/b> from 12 Google reviews/);
  assert.match(html, /href="tel:07969770905"/);
  assert.match(html, /Book a free trial class/); // a gym, not "get a quote"
  assert.match(html, /\/d\/diamond-kickboxing-academy-abc234\/order/);
  assert.match(html, /preview until Sunday 18 October/);
  assert.match(html, /noindex/);
  const nasty = renderDemo({ ...LEAD, name: '<script>alert(1)</script> Roofing', trade: "roofer" }, DEMO);
  assert.doesNotMatch(nasty, /<script>alert/);
  assert.match(nasty, /Get a free quote/);
  assert.deepEqual(servicesFor("Roofer").slice(0, 2), ["New roofs", "Roof repairs"]);
});

test("slugs are readable and unguessable", () => {
  const s = slugFor("Smith & Sons Roofing Ltd");
  assert.match(s, /^smith-and-sons-roofing-[a-z2-9]{6}$/);
  assert.notEqual(slugFor("Smith"), slugFor("Smith"));
});

test("the order page follows the offer: weekday prices, weekend deal, links carry the lead", () => {
  const links = { full: { url: "https://buy.stripe.com/full" }, weekend: { url: "https://buy.stripe.com/wknd" }, website: { url: "https://buy.stripe.com/site" } };
  const weekday = renderOrder(LEAD, DEMO, links, new Date("2026-10-07T10:00:00Z"));
  assert.match(weekday, /£1,950/);
  assert.match(weekday, /first 60 days free/);
  assert.match(weekday, /buy\.stripe\.com\/full\?client_reference_id=p1/);
  assert.match(weekday, /No contract/);
  const weekend = renderOrder(LEAD, DEMO, links, new Date("2026-10-10T10:00:00Z"));
  assert.ok(isWeekendUK(new Date("2026-10-10T10:00:00Z")));
  assert.match(weekend, /£1,750/);
  // The struck-through price is the real weekday price, never £2,000 (truth rule: a false price comparison).
  assert.match(weekend, /<span class="was">£1,950<\/span>£1,750/);
  assert.doesNotMatch(weekend, /£2,000/);
  assert.doesNotMatch(weekday, /class="was"/);
  assert.match(weekend, /first 90 days free/);
  assert.match(weekend, /buy\.stripe\.com\/wknd/);
  assert.match(renderOrder(LEAD, DEMO, {}), /go off/); // no Stripe yet: buttons disabled, not broken
  assert.match(renderExpired(LEAD), /preview has ended/);
});

test("the order page offers no extra whose switch is off, and words the guarantee as overview §9 does", () => {
  const escaped = (t) => t.replace(/'/g, "&#39;");
  const EXTRAS = /receptionist|chatbot|chat assistant|review booster/i;
  const OLD_GUARANTEE = /work free until you are|working for free until you are|Front page of Google in 90 days/;
  for (const now of [new Date("2026-10-07T10:00:00Z"), new Date("2026-10-10T10:00:00Z")]) {
    // Both switches default off: nothing shows the chatbot or the review booster (truth rule).
    for (const html of [renderOrder(LEAD, DEMO, {}, now), renderOrder(LEAD, DEMO, {}, now, { chatbot: false, reviews: false })]) {
      assert.doesNotMatch(html, EXTRAS);
      assert.doesNotMatch(html, OLD_GUARANTEE);
      assert.ok(html.includes(GUARANTEE.headline), "the Full Package lists the guarantee headline");
      assert.ok(html.includes(escaped(GUARANTEE.section)), "the FAQ has the guarantee section");
      assert.ok(html.includes(BUILD_GUARANTEE), "Website Only lists the build guarantee");
    }
    // The review booster shows once its switch is on; the chatbot's line comes with stage 10, so never here.
    const reviews = renderOrder(LEAD, DEMO, {}, now, { chatbot: false, reviews: true });
    assert.match(reviews, /<li>Review booster<\/li>/);
    assert.doesNotMatch(reviews, /receptionist|chatbot|chat assistant/i);
    assert.doesNotMatch(renderOrder(LEAD, DEMO, {}, now, { chatbot: true, reviews: false }), EXTRAS);
  }
});

test("the order route reads the extras switches and passes them on", async () => {
  const { onRequestGet } = await import("../functions/d/[slug]/order.js");
  const DB = fakeD1();
  const later = new Date(Date.now() + 7 * 86400000).toISOString();
  DB.raw.prepare("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', 'x', 'x')").run();
  DB.raw.prepare("INSERT INTO demos (slug, place_id, created_at, expires_at) VALUES ('smith-roofing-abc234', 'p1', 'x', ?)").run(later);
  const html = async () => (await onRequestGet({ env: { DB }, params: { slug: "smith-roofing-abc234" } })).text();
  const off = await html();
  assert.match(off, /Make it yours/);
  assert.doesNotMatch(off, /review booster|receptionist/i);
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('offer:review_booster_live', '1')").run();
  assert.match(await html(), /<li>Review booster<\/li>/);
});

test("one live demo per lead; views count once per 30 minutes; expired demos stop counting", async () => {
  const DB = fakeD1();
  const at = new Date("2026-10-04T10:00:00Z");
  const d1 = await ensureDemo(DB, LEAD, at);
  assert.equal((await ensureDemo(DB, LEAD, at)).slug, d1.slug);
  assert.equal(d1.expires_at, "2026-10-18T10:00:00.000Z");
  assert.equal(await recordEvent(DB, d1, "view", at), true);
  assert.equal(await recordEvent(DB, d1, "view", new Date(at.getTime() + 60000)), false);
  assert.equal(await recordEvent(DB, d1, "view", new Date(at.getTime() + 31 * 60000)), true);
  assert.equal(await recordEvent(DB, d1, "hack", at), false);
  assert.equal(await recordEvent(DB, d1, "view", new Date("2026-10-20T10:00:00Z")), false);
  const later = await ensureDemo(DB, LEAD, new Date("2026-10-20T10:00:00Z"));
  assert.notEqual(later.slug, d1.slug); // a fresh one after expiry
});

test("Start outreach builds their demo straight away", async () => {
  const DB = fakeD1();
  DB.raw.prepare("INSERT INTO leads (place_id, name, trade, search_town, email, status, excluded, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', 'dave@smith.co.uk', 'new', 0, 'x', 'x')").run();
  const res = await enrol({ request: new Request("https://x", { method: "POST", body: JSON.stringify({ place_ids: ["p1"] }) }), env: { DB } });
  const out = await res.json();
  assert.match(out.demos.p1.slug, /^smith-roofing-/);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM demos").get().n, 1);
});

test("their own logo, colour, photos and real reviews make it theirs; unsafe values are dropped", () => {
  const lead = { ...LEAD, name: "Green Acres Landscaping", trade: "landscaper", audit: JSON.stringify({
    brand: { logo: "https://greenacres.co.uk/logo.png", colour: "#2e7d32", photos: ["https://greenacres.co.uk/a.jpg", "https://greenacres.co.uk/b.jpg", "javascript:alert(1)"] },
    reviews: [{ author: "Sarah K.", rating: 5, text: "Gary transformed our garden, new patio and lawn." }] }) };
  const html = renderDemo(lead, DEMO);
  assert.match(html, /<img src="https:\/\/greenacres\.co\.uk\/logo\.png"/);
  assert.match(html, /--main:#2e7d32/);
  assert.match(html, /url\("https:\/\/greenacres\.co\.uk\/a\.jpg"\)/); // hero photo
  assert.match(html, /Work by Green Acres Landscaping/);
  assert.match(html, /Gary transformed our garden/);
  assert.match(html, /Patios &amp; paving/);
  assert.doesNotMatch(html, /javascript:alert/);
  // nothing found: no empty photo boxes, trade colour instead
  const plain = renderDemo({ ...LEAD, trade: "landscaper", audit: "{}" }, DEMO);
  assert.doesNotMatch(plain, /Your photo|Our work/);
  assert.match(plain, /--main:#2f6b3a/);
  // a hostile business name can't break out of the logo fallback
  const evil = renderDemo({ ...lead, name: "x';alert(1);' <b>" }, DEMO);
  assert.doesNotMatch(evil, /alert\(1\);'/);
  assert.match(evil, /x&#39;;alert\(1\);&#39; &lt;b&gt;/);
});
