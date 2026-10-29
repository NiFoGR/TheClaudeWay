// Printable Google review QR card, /s/review-card on the client host (stage 10, Task 18; 09-build.md section 12).
// Run: node --test control-room/tests/sites-card.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderReviewCard } from "../functions/_lib/sites/card.js";
import { qrSvg } from "../functions/_lib/sites/qr.js";
import { reviewMessages } from "../functions/_lib/sites/copy.js";

const L = "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4";
const ARGS = { business: "Smith Roofing", phone: "01793 123456", owner: "John", reviewUrl: L };
const BANNED = /happy|satisf|discount|voucher|prize|win\b/i;

// The printed sheet: everything from the sheet's opening tag up to the screen-only block.
function sheetOf(html) {
  const start = html.indexOf('<main class="sheet"');
  const end = html.indexOf('class="screen-only"');
  assert.ok(start > 0 && end > start, "the sheet comes before the screen-only block");
  return html.slice(start, html.lastIndexOf("<", end));
}

// Each card's own markup (cards don't nest).
function cardsOf(html) {
  return [...sheetOf(html).matchAll(/<div class="card">([\s\S]*?)<\/div><!-- \/card -->/g)].map((m) => m[1]);
}

test("8 business cards, each with the heading, the business name, the phone and one QR code", () => {
  const html = renderReviewCard(ARGS);
  assert.equal((html.match(/class="card"/g) || []).length, 8);
  const cards = cardsOf(html);
  assert.equal(cards.length, 8);
  for (const card of cards) {
    assert.ok(card.includes("How did we do?"));
    assert.ok(card.includes("Smith Roofing"));
    assert.ok(card.includes("01793 123456"));
    assert.ok(card.includes("We'd really appreciate a Google review. Scan the code with your phone camera.")
      || card.includes("We&#39;d really appreciate a Google review. Scan the code with your phone camera."));
    assert.equal((card.match(/<svg/g) || []).length, 1);
  }
  assert.equal((html.match(/<svg/g) || []).length, 8, "no other SVG on the page");
});

test("the QR on every card is the review URL itself (Task 17's SVG, unchanged)", () => {
  const html = renderReviewCard(ARGS);
  const svg = qrSvg(L);
  for (const card of cardsOf(html)) assert.ok(card.includes(svg));
});

test("A4 print CSS: 85mm x 55mm cards, screen-only parts and the Print button hidden when printing", () => {
  const html = renderReviewCard(ARGS);
  assert.ok(html.includes("@page { size: A4"));
  assert.ok(html.includes("85mm"));
  assert.ok(html.includes("55mm"));
  assert.ok(html.includes("@media print { .screen-only, .print-btn { display: none } }"));
  assert.match(html, /<button[^>]*class="print-btn"[^>]*>Print<\/button>/);
});

test("noindex, a whole HTML page, no third-party scripts, no external anything", () => {
  const html = renderReviewCard(ARGS);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!/<script[^>]+src=/i.test(html), "no script src");
  assert.ok(!/<link[^>]+href=/i.test(html), "no external stylesheet");
  assert.ok(!/https?:\/\/(?!search\.google\.com|www\.w3\.org)/.test(html), "the only URLs are the review link and the SVG namespace");
});

test("the three templates sit under a .screen-only block with Copy buttons, exact section 12 text", () => {
  const html = renderReviewCard(ARGS);
  const at = html.indexOf('class="screen-only"');
  assert.ok(at > 0);
  const screen = html.slice(at);
  assert.equal((screen.match(/<button[^>]*>Copy<\/button>/g) || []).length, 3);
  const m = reviewMessages({ business: "Smith Roofing", owner: "John", link: L });
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  assert.ok(screen.includes(esc(m.sms)), "text/WhatsApp message");
  assert.ok(screen.includes(esc(m.email.subject)), "email subject");
  assert.ok(screen.includes(esc(m.email.body)), "email body");
  assert.ok(screen.includes(esc(m.reminder)), "reminder");
  assert.ok(screen.includes("{customer}"), "the customer's name is left for the client to fill");
  assert.ok(!sheetOf(html).includes("{customer}"), "templates aren't on the printed sheet");
});

test("the owner's first name signs the templates; blank signs with the business name", () => {
  assert.ok(renderReviewCard(ARGS).includes("Thanks, John"));
  const html = renderReviewCard({ ...ARGS, owner: "" });
  assert.ok(html.includes("No worries if not. Smith Roofing"));
});

test("a business name with markup is escaped everywhere", () => {
  const html = renderReviewCard({ ...ARGS, business: "A&B <x>", phone: "<b>0179</b>" });
  assert.ok(!html.includes("<x>"));
  assert.ok(!html.includes("<b>0179"));
  assert.ok(html.includes("A&amp;B &lt;x&gt;"));
  assert.ok(html.includes("&lt;b&gt;0179&lt;/b&gt;"));
  for (const card of cardsOf(html)) assert.ok(card.includes("A&amp;B &lt;x&gt;"));
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.includes("A&amp;B &lt;x&gt;"));
});

test("a script-breaking business name can't escape the page's inline script or attributes", () => {
  const html = renderReviewCard({ ...ARGS, business: 'Bob"</script><script>alert(1)</script>' });
  assert.equal((html.match(/<script/g) || []).length, 1, "only the page's own script");
  assert.ok(!html.includes('Bob"'));
});

test("no gating, no incentive words on the printed cards", () => {
  for (const business of ["Smith Roofing", "Happy Plumbing Ltd"]) {
    const html = renderReviewCard({ ...ARGS, business });
    const cards = cardsOf(html);
    assert.equal(cards.length, 8);
    for (const card of cards) {
      const text = card.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/Happy Plumbing Ltd/g, "");
      assert.ok(!BANNED.test(text), text);
    }
  }
  const sheet = sheetOf(renderReviewCard(ARGS)).replace(/<svg[\s\S]*?<\/svg>/g, "");
  assert.ok(!BANNED.test(sheet), "the whole printed sheet");
  // The exact Step 1 check: the cards' whole markup, QR included, nothing stripped.
  for (const card of cardsOf(renderReviewCard(ARGS))) assert.doesNotMatch(card, BANNED);
});

test("no phone: the cards still print, with no empty phone line", () => {
  const html = renderReviewCard({ ...ARGS, phone: "  " });
  const cards = cardsOf(html);
  assert.equal(cards.length, 8);
  for (const card of cards) assert.ok(!card.includes('class="phone"'));
});

test("no usable review link: a plain noindex page that says so, no cards, no QR", () => {
  for (const reviewUrl of [null, "", "https://evil.com/x", "javascript:alert(1)"]) {
    const html = renderReviewCard({ ...ARGS, reviewUrl });
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(!html.includes('class="card"'));
    assert.ok(!html.includes("<svg"));
    assert.ok(html.includes("There's no Google review link for this business yet.")
      || html.includes("There&#39;s no Google review link for this business yet."));
  }
});

test("a pasted g.page link is encoded as given (cards keep working without our host)", () => {
  const link = "https://g.page/r/CabcDEF123/review";
  const html = renderReviewCard({ ...ARGS, reviewUrl: link });
  for (const card of cardsOf(html)) assert.ok(card.includes(qrSvg(link)));
  assert.ok(!/aetos/i.test(sheetOf(html)), "the client's card, not ours");
});

test("a review link too long for a QR code: a plain page saying what to do, never a crash", () => {
  const html = renderReviewCard({ ...ARGS, reviewUrl: `https://g.page/r/${"a".repeat(3000)}/review` });
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes('class="card"'));
  assert.ok(!html.includes("<svg"));
  assert.match(html, /too long to fit in a QR code/);
});

test("on a phone screen only the A4 sheet scrolls sideways, not the whole page", () => {
  const html = renderReviewCard(ARGS);
  assert.match(html, /@media screen \{[^@]*\.sheet \{[^}]*max-width: 100%; overflow-x: auto/);
});
