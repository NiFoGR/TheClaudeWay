// Demo page quality checks (pure, regex only): size, outside scripts, noindex, alt text, lazy images, every number
// traceable, no banned claims, preview bar, disabled form, nothing unescaped, mobile viewport.
// Run: node --test control-room/tests/demo-check.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { BANNED_CLAIMS, checkDemoHtml } from "../functions/_lib/demo/check.js";

const data = { business: { name: "A", phone: "07969 770905" }, rating: 4.8, review_count: 37, copy: { headline: "H" } };
const ok = `<meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><div class="ae-bar">Preview made for A</div><p>4.8 from 37 Google reviews · 07969 770905 · 90 days · top 3</p><fieldset disabled></fieldset>`;
const NOW = new Date("2026-10-21");

test("spec: a clean page passes and each problem has its exact message", () => {
  assert.deepEqual(checkDemoHtml(ok, data, { now: new Date("2026-10-21") }), []);
  assert.deepEqual(checkDemoHtml(ok.replace("37", "250"), data), ['Number "250" isn\'t in their data']);
  assert.ok(checkDemoHtml(ok + "<p>Free quote</p>", data).includes('Says "free quote" but their data doesn\'t'));
  assert.ok(checkDemoHtml(ok + '<script src="https://cdn.x/y.js"></script>', data).includes("Loads an outside script or stylesheet"));
  assert.ok(checkDemoHtml(ok.replace("<fieldset disabled>", "<fieldset>"), data).includes("Quote form isn't disabled"));
  assert.ok(checkDemoHtml(ok + "<p><b>x</b></p>", { ...data, copy: { headline: "<b>x</b>" } }).some((p) => p.startsWith("Unescaped text")));
  assert.ok(checkDemoHtml(ok + "x".repeat(100001), data)[0].startsWith("Page is"));
});

test("BANNED_CLAIMS is the exact list", () => {
  assert.deepEqual(BANNED_CLAIMS, ["free quote", "fully insured", "years of experience", "24/7", "family run", "award", "no.1", "best"]);
});

test("size: bytes are counted as UTF-8 and the message gives KB against the 100 KB limit", () => {
  assert.deepEqual(checkDemoHtml(ok + "x".repeat(100001), data, { now: NOW }), ["Page is 101 KB (limit 100 KB)"]);
  const justUnder = ok + "x".repeat(99999 - Buffer.byteLength(ok));
  assert.equal(Buffer.byteLength(justUnder), 99999);
  assert.deepEqual(checkDemoHtml(justUnder, data, { now: NOW }), []);
  const pounds = ok + "·".repeat(50000);                               // 2 bytes each in UTF-8: over the limit
  assert.match(checkDemoHtml(pounds, data, { now: NOW })[0], /^Page is \d+ KB \(limit 100 KB\)$/);
});

test("outside scripts and stylesheets are caught; inline ones and a canonical link are fine", () => {
  const msg = "Loads an outside script or stylesheet";
  for (const bad of ['<script src="/x.js"></script>', "<SCRIPT type=module SRC=https://x.co/a.js></SCRIPT>",
    '<link rel="stylesheet" href="https://fonts.x/a.css">', "<link href=https://x.co/a.css rel=stylesheet>",
    '<link rel="modulepreload" href="/a.js">', "<style>@import url(https://x.co/a.css);</style>",
    '<style>@font-face{font-family:x;src:url("https://x.co/f.woff2")}</style>'])
    assert.deepEqual(checkDemoHtml(ok + bad, data, { now: NOW }), [msg], bad);
  for (const fine of ["<script>var a=1</script>", "<style>body{margin:0}</style>", '<link rel="canonical" href="https://x.co/">',
    '<p data-src="x">A</p>', '<img src="https://x.co/a.jpg" alt="A logo" width="1" height="1">'])
    assert.deepEqual(checkDemoHtml(ok + fine, data, { now: NOW }), [], fine);
});

test("noindex, preview bar and disabled form are demo-only; viewport is always needed", () => {
  const noRobots = ok.replace('<meta name="robots" content="noindex,nofollow">', "");
  assert.deepEqual(checkDemoHtml(noRobots, data, { now: NOW }), ["Missing noindex"]);
  assert.deepEqual(checkDemoHtml(ok.replace("noindex,nofollow", "nofollow"), data, { now: NOW }), ["Missing noindex"]);
  assert.deepEqual(checkDemoHtml(ok.replace('name="robots" content="noindex,nofollow"', "content='NOINDEX, nofollow' name=robots"), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok.replace(/<div class="ae-bar">.*?<\/div>/, ""), data, { now: NOW }), ["Preview bar missing"]);
  assert.deepEqual(checkDemoHtml(ok.replace('class="ae-bar"', 'class="top"'), data, { now: NOW }), ["Preview bar missing"]);
  assert.deepEqual(checkDemoHtml(ok.replace("Preview made for A", "A"), data, { now: NOW }), ["Preview bar missing"]);
  assert.deepEqual(checkDemoHtml(ok.replace('class="ae-bar"', 'class="ae-bar sticky"'), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok.replace("<fieldset disabled></fieldset>", ""), data, { now: NOW }), ["Quote form isn't disabled"]);
  assert.deepEqual(checkDemoHtml(ok.replace("<fieldset disabled>", '<fieldset class="disabled">'), data, { now: NOW }), ["Quote form isn't disabled"]);
  assert.deepEqual(checkDemoHtml(ok + "<fieldset></fieldset>", data, { now: NOW }), ["Quote form isn't disabled"]);
  assert.deepEqual(checkDemoHtml(ok.replace("<fieldset disabled>", '<fieldset class="f" disabled="disabled">'), data, { now: NOW }), []);
  // Live mode (stage 10's sites): no noindex, no bar, the form posts for real.
  const live = '<meta name="viewport" content="width=device-width, initial-scale=1"><p>A</p><form action="https://x.co/send"><fieldset></fieldset></form>';
  assert.deepEqual(checkDemoHtml(live, data, { mode: "live", now: NOW }), []);
  assert.deepEqual(checkDemoHtml(live.replace(/<meta[^>]*>/, ""), data, { mode: "live", now: NOW }), ["Missing mobile viewport"]);
  assert.deepEqual(checkDemoHtml(ok.replace('content="width=device-width"', 'content="width=1024"'), data, { now: NOW }), ["Missing mobile viewport"]);
});

test("images: every one needs alt text; all but the first two must be lazy", () => {
  const img = (attrs) => `<img src="https://x.co/a.jpg" width="1" height="1" ${attrs}>`;
  const top = img('alt="A logo"') + img('alt="Work by A" fetchpriority="high"');
  assert.deepEqual(checkDemoHtml(ok + top + img('alt="Work by A" loading="lazy"'), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok + top + img('alt="Work by A"'), data, { now: NOW }), ["Image below the top isn't lazy-loaded"]);
  assert.deepEqual(checkDemoHtml(ok + top + img("alt='Work by A' loading=lazy"), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok + img(""), data, { now: NOW }), ["Image without alt text"]);
  assert.deepEqual(checkDemoHtml(ok + img('alt=""'), data, { now: NOW }), ["Image without alt text"]);
  assert.deepEqual(checkDemoHtml(ok + img('alt="  "'), data, { now: NOW }), ["Image without alt text"]);
  assert.deepEqual(checkDemoHtml(ok + img('data-alt="A logo"'), data, { now: NOW }), ["Image without alt text"]);
  // Both problems at once, each reported once.
  assert.deepEqual(checkDemoHtml(ok + top + img("") + img(""), data, { now: NOW }), ["Image without alt text", "Image below the top isn't lazy-loaded"]);
});

test("numbers: only from their data, the guarantee (3, 90), the offer line (60/90) and this year", () => {
  assert.deepEqual(checkDemoHtml(ok + "<p>First 60 days free. Weekend: 90 days.</p><footer>© 2026 A</footer>", data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok + "<footer>© 2025 A</footer>", data, { now: NOW }), ['Number "2025" isn\'t in their data']);
  assert.deepEqual(checkDemoHtml(ok + "<footer>© 2027 A</footer>", data, { now: new Date("2027-01-01T00:00:00Z") }), []);
  // Each unknown number once, in the order it first appears.
  assert.deepEqual(checkDemoHtml(ok + "<p>Over 500 jobs, 12 vans, 500 smiles</p>", data, { now: NOW }),
    ['Number "500" isn\'t in their data', 'Number "12" isn\'t in their data']);
  // Markup, CSS, scripts, comments and attributes aren't visible text, and entities are decoded first (&#39; is ').
  const hidden = '<style>.a{width:250px}</style><script>var t=4000</script><!-- 999 --><svg viewBox="0 0 24 24"><path d="M12 2l3 7"/></svg><a href="tel:01234567890" data-n="77">Call A</a><p>A&#39;s &#x27;team&#x27; &amp; &nbsp;co</p>';
  assert.deepEqual(checkDemoHtml(ok + hidden, data, { now: NOW }), []);
  // A number is a digit run: their phone's pieces are fine, a new run made of the same digits isn't.
  assert.deepEqual(checkDemoHtml(ok + "<p>07969</p><p>770905</p>", data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok + "<p>0796</p>", data, { now: NOW }), ['Number "0796" isn\'t in their data']);
  // Tags between digits don't glue them into a new number.
  assert.deepEqual(checkDemoHtml(ok + "<p>3</p><p>8</p>", data, { now: NOW }), []);              // not "38"
  // Prices are never on the demo: "£1,950" is reported as the number it is.
  assert.ok(checkDemoHtml(ok + "<p>£1,950</p>", data, { now: NOW }).includes('Number "1,950" isn\'t in their data'));
  // The same number written the way people read it is still theirs: 5 shown as "5.0", 4.83 as "4.8", 1234 as "1,234".
  assert.deepEqual(checkDemoHtml(ok.replace("4.8 from 37", "5.0 ★ from 1,234"), { ...data, rating: 5, review_count: 1234 }, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok.replace("4.8", "4.83"), data, { now: NOW }), ['Number "4.83" isn\'t in their data']);
  assert.deepEqual(checkDemoHtml(ok, { ...data, rating: 4.83 }, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok.replace("4.8", "4.9"), data, { now: NOW }), ['Number "4.9" isn\'t in their data']);
  // Digits made by entities are shown too.
  assert.deepEqual(checkDemoHtml(ok + "<p>&#50;&#53;&#48;</p>", data, { now: NOW }), ['Number "250" isn\'t in their data']);
});

test("banned claims: only when their data doesn't say it; whole words, any case, hyphen or space", () => {
  const says = (claim) => `Says "${claim}" but their data doesn't`;
  const cases = [["<p>FREE QUOTES</p>", "free quote"], ["<p>Fully insured</p>", "fully insured"],
    ["<p>Years of experience</p>", "years of experience"], ["<p>Open 24/7</p>", "24/7"], ["<p>A family-run firm</p>", "family run"],
    ["<p>Award-winning</p>", "award"], ["<p>Awards</p>", "award"], ["<p>The No.1 choice</p>", "no.1"], ["<p>No. 1 in town</p>", "no.1"],
    ["<p>The <b>best</b> in town</p>", "best"], ["<p>Free <b>quote</b></p>", "free quote"]];
  for (const [html, claim] of cases)
    assert.ok(checkDemoHtml(ok + html, { ...data, review_count: 37 }, { now: NOW }).includes(says(claim)), `${html} → ${claim}`);
  // Words that only contain a claim aren't it.
  for (const fine of ["<p>Asbestos removal</p>", "<p>Bestway Road</p>", "<p>Ask for a quote</p>", "<p>Notice</p>"])
    assert.deepEqual(checkDemoHtml(ok + fine, data, { now: NOW }), [], fine);
  // Their own words may say it: a business name, a review, Claude's copy from their site.
  const theirs = { ...data, business: { ...data.business, name: "Best Fencing" }, reviews: [{ author: "Sam T.", rating: 5, text: "Award winning work, fully-insured and family run" }] };
  assert.deepEqual(checkDemoHtml(ok + "<h1>Best Fencing</h1><p>Award winning work, fully-insured and family run</p>", theirs, { now: NOW }), []);
  // A claim hiding inside another word of their data doesn't count as them saying it, nor does a key name.
  assert.ok(checkDemoHtml(ok + "<p>The best</p>", { ...data, copy: { headline: "Asbestos removal" } }, { now: NOW }).includes(says("best")));
  assert.ok(checkDemoHtml(ok + "<p>The best</p>", { ...data, best: true }, { now: NOW }).includes(says("best")));
  // Text in markup isn't visible: an attribute or a stylesheet saying "best" is fine.
  assert.deepEqual(checkDemoHtml(ok + '<p class="best">A</p><style>.best{}</style>', data, { now: NOW }), []);
});

test("unescaped text: a data string with < > or \" found verbatim in the page", () => {
  const nasty = '"><img src=x onerror=alert(1)>';
  const d = { ...data, reviews: [{ author: "x", rating: 5, text: nasty }] };
  assert.deepEqual(checkDemoHtml(ok + `<p>${nasty}</p>`, d, { now: NOW }), ["Image without alt text", `Unescaped text: ${nasty.slice(0, 30)}`]);
  assert.deepEqual(checkDemoHtml(ok + "<p>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</p>", d, { now: NOW }), []);
  // First 30 characters only, and each string once even when it's found twice.
  const long = "<script>alert('a very long hostile string')</script>";
  const dl = { ...data, business: { ...data.business, town: long } };
  const probs = checkDemoHtml(ok + `<p>${long}</p><p>${long}</p>`, dl, { now: NOW }).filter((p) => p.startsWith("Unescaped"));
  assert.deepEqual(probs, [`Unescaped text: ${long.slice(0, 30)}`]);
  // Strings without < > " are not this check's business, nor are numbers.
  assert.deepEqual(checkDemoHtml(ok + "<p>A &amp; B</p>", { ...data, copy: { headline: "A & B" } }, { now: NOW }), []);
});

test("problems come in the listed order and bad input never throws", () => {
  const bad = "<p>Free quote 250</p><img src=x>" + '<script src="/a.js"></script>' + "x".repeat(100001);
  assert.deepEqual(checkDemoHtml(bad, { copy: { headline: "<i>" } }, { now: NOW }), [
    "Page is 101 KB (limit 100 KB)", "Loads an outside script or stylesheet", "Missing noindex", "Image without alt text",
    'Number "250" isn\'t in their data', 'Says "free quote" but their data doesn\'t', "Preview bar missing",
    "Quote form isn't disabled", "Missing mobile viewport",
  ]);
  for (const html of [null, undefined, "", 42]) assert.ok(Array.isArray(checkDemoHtml(html, null)));
  assert.ok(checkDemoHtml("", undefined).includes("Missing mobile viewport"));
  assert.deepEqual(checkDemoHtml(ok, data, { now: "2026-10-21T10:00:00Z" }), []);
  assert.deepEqual(checkDemoHtml(ok, data, { now: new Date("nope") }), []);
});

test("hostile markup stays fast (the checks run on every preview and on /api/demo/check)", () => {
  for (const tail of ["<a".repeat(45000), '<a x="'.repeat(15000), "<style>" + "@font-face{".repeat(9000), "<script".repeat(14000), "<!--".repeat(25000)]) {
    const t = Date.now();
    assert.ok(Array.isArray(checkDemoHtml(ok + tail, data, { now: NOW })));
    assert.ok(Date.now() - t < 1500, `${tail.slice(0, 12)}… took ${Date.now() - t} ms`);
  }
});

test("review: a very long decimal is reported, never throws (toFixed takes at most 100 places)", () => {
  const long = "1." + "2".repeat(120);
  assert.deepEqual(checkDemoHtml(ok + `<p>${long}</p>`, data, { now: NOW }), [`Number "${long}" isn't in their data`]);
});

test("review: data is compared the way h() shows it (control and bidi characters removed)", () => {
  // "0796977<BEL>0905" in their data is shown as 07969770905: their number, not an invented one.
  const ctrl = { ...data, copy: { headline: "H", intro: "Mobile 0796977\u00070905" } };
  assert.deepEqual(checkDemoHtml(ok + "<p>07969770905</p>", ctrl, { now: NOW }), []);
  // A run is compared as written: "07969" in their data doesn't make "7969" theirs.
  assert.deepEqual(checkDemoHtml(ok + "<p>7969</p>", data, { now: NOW }), ['Number "7969" isn\'t in their data']);
  const bidi = { ...data, business: { ...data.business, name: "Be\u202Est Fencing" } };
  assert.deepEqual(checkDemoHtml(ok + "<h1>Best Fencing</h1>", bidi, { now: NOW }), []);
});

test("review: an SVG <script href> is an outside script too", () => {
  for (const bad of ['<svg><script href="https://x.co/a.js"></script></svg>', '<svg><script xlink:href="/a.js"></script></svg>'])
    assert.deepEqual(checkDemoHtml(ok + bad, data, { now: NOW }), ["Loads an outside script or stylesheet"], bad);
});

test("review: words people see in attributes count (button value, placeholder, alt, title)", () => {
  const inForm = (x) => ok.replace("</fieldset>", `${x}</fieldset>`);
  const says = (claim) => `Says "${claim}" but their data doesn't`;
  assert.deepEqual(checkDemoHtml(inForm('<input type="submit" value="Get a free quote">'), data, { now: NOW }), [says("free quote")]);
  assert.deepEqual(checkDemoHtml(inForm('<textarea placeholder="Best time to call"></textarea>'), data, { now: NOW }), [says("best")]);
  assert.deepEqual(checkDemoHtml(ok + '<img src="https://x.co/a.jpg" alt="Award-winning work by A">', data, { now: NOW }), [says("award")]);
  assert.deepEqual(checkDemoHtml(ok + '<a href="#q" title="Fully insured">Ask</a>', data, { now: NOW }), [says("fully insured")]);
  // A made-up phone number in a placeholder is an invented number on the page.
  assert.deepEqual(checkDemoHtml(inForm('<input name="phone" placeholder="e.g. 07700 900123">'), data, { now: NOW }),
    ['Number "07700" isn\'t in their data', 'Number "900123" isn\'t in their data']);
  // Values nobody sees, screen-reader labels, data- and link attributes stay out of it.
  assert.deepEqual(checkDemoHtml(inForm('<input type="hidden" name="t" value="12345 best">'), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(ok + '<span aria-label="Rated 4.8 out of 5">★★★★★</span><a href="/best/250" data-x="award">A</a>', data, { now: NOW }), []);
  // Their own name in alt text is theirs.
  const best = { ...data, business: { ...data.business, name: "Best Fencing" } };
  assert.deepEqual(checkDemoHtml(ok + '<img src="https://x.co/a.jpg" alt="Best Fencing logo">', best, { now: NOW }), []);
});

test("review: a link or image file name in their data isn't them making a claim", () => {
  const d = { ...data, brand: { logo: "https://x.co/best-logo.png", photos: ["https://x.co/award-winning-patio.jpg"] }, demo: { order_url: "/d/best-x/order" } };
  const probs = checkDemoHtml(ok + "<p>The best, award winning</p>", d, { now: NOW });
  assert.deepEqual(probs, ['Says "award" but their data doesn\'t', 'Says "best" but their data doesn\'t']);
});

test("review: a form control outside the disabled fieldset means the form isn't disabled (demo mode)", () => {
  const msg = "Quote form isn't disabled";
  const after = (x) => ok.replace("</fieldset>", `</fieldset>${x}`);
  const inside = (x) => ok.replace("</fieldset>", `${x}</fieldset>`);
  for (const bad of ["<button>Send</button>", '<input name="n">', "<textarea></textarea>", "<select></select>", '<BUTTON type="submit">Send</BUTTON>'])
    assert.deepEqual(checkDemoHtml(after(bad), data, { now: NOW }), [msg], bad);
  assert.deepEqual(checkDemoHtml(after("<button disabled>Send</button>"), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(inside('<label>Name <input name="n"></label><textarea name="m"></textarea><button>Send</button>'), data, { now: NOW }), []);
  assert.deepEqual(checkDemoHtml(inside("<fieldset disabled><input></fieldset><input>"), data, { now: NOW }), []);   // nested
  assert.deepEqual(checkDemoHtml(inside("<fieldset><input></fieldset>"), data, { now: NOW }), [msg]);                  // an enabled one inside
  // A stray closing tag doesn't let a later control count as inside.
  assert.deepEqual(checkDemoHtml(after("</fieldset><input>"), data, { now: NOW }), [msg]);
  // Live mode: the form is meant to work.
  const live = '<meta name="viewport" content="width=device-width"><form action="https://x.co/send"><input name="n"><button>Send</button></form>';
  assert.deepEqual(checkDemoHtml(live, data, { mode: "live", now: NOW }), []);
});

test("review: the unescaped-text message never carries bidi or control characters into the Control Room", () => {
  const nasty = "\u202E<b>evil\u0007</b>";
  const d = { ...data, copy: { headline: nasty } };
  assert.deepEqual(checkDemoHtml(ok + `<p>${nasty}</p>`, d, { now: NOW }), ["Unescaped text: <b>evil</b>"]);
  assert.deepEqual(checkDemoHtml(ok + "<p><b>evil</b></p>", d, { now: NOW }), ["Unescaped text: <b>evil</b>"]);   // as h() would have left it
});

test("review: hostile form markup stays fast too", () => {
  for (const tail of ["<input".repeat(16000), '<button x="'.repeat(9000), "<fieldset ".repeat(10000), '<input value="'.repeat(8000), '<img alt="'.repeat(10000)]) {
    const t = Date.now();
    assert.ok(Array.isArray(checkDemoHtml(ok + tail, data, { now: NOW })));
    assert.ok(Date.now() - t < 1500, `${tail.slice(0, 12)}… took ${Date.now() - t} ms`);
  }
});
