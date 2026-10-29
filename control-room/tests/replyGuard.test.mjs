// Reply guard (pure): the server's checks on every reply Claude writes, with Part A's exact reasons.
// Run: node --test control-room/tests/replyGuard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { offerFacts } from "../functions/_lib/offer.js";
import { REPLY_HOSTS, replyGuard } from "../functions/_lib/replyGuard.js";

const WEEKDAY = offerFacts(new Date("2026-10-21T10:00:00Z"));
const CTX = { offer: WEEKDAY, hosts: REPLY_HOSTS, slug: "green-leaf-ab12", signName: "Nik" };
const OK = "Hi Sam,\n\nSure. Click the link below to see the website I made for you and browse around.\n\nhttps://aetoswebsites.com/d/green-leaf-ab12\nOur own site: aetoswebsites.com\n\nIf you have any further questions, feel free to ask here.";
const why = (b, c = CTX) => replyGuard(b, c).reasons;

test("a good reply passes", () => assert.deepEqual(replyGuard(OK, CTX), { ok: true, reasons: [] }));
test("length", () => assert.deepEqual(why("word ".repeat(181)), ["Too long: 181 words (180 max)."]));
test("prices", () => {
  assert.deepEqual(why("It's £1,500."), ["£1,500 isn't one of our prices (£249, £1,750, £1,950)."]);
  assert.deepEqual(why("Normally £2,000."), ["£2,000 isn't one of our prices (£249, £1,750, £1,950)."]);
  assert.deepEqual(why("It's £1950 then £249.00 a month."), []);
  for (const b of ["About 2k.", "1950 pounds", "1950 quid", "£1.95k"]) assert.deepEqual(why(b), ["Write prices in full with £, e.g. £1,950."]);
});
test("SEO in any form", () => { for (const b of ["We do SEO.", "s.e.o work", "local Seo"]) assert.deepEqual(why(b), ["Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\"."]); });
test("links and addresses", () => {
  assert.deepEqual(why("See bit.ly/x"), ["Links can only go to their demo, their order page or aetoswebsites.com (found bit.ly)."]);
  assert.deepEqual(why("https://control.aetoswebsites.com/d/green-leaf-ab12"), ["Links can only go to their demo, their order page or aetoswebsites.com (found control.aetoswebsites.com)."]);
  assert.deepEqual(why("https://aetoswebsites.com/d/other-slug"), ["That link is another business's demo (/d/other-slug)."]);
  assert.deepEqual(why("https://aetoswebsites.com/d/green-leaf-ab12/order"), []);
  assert.deepEqual(why("www.aetoswebsites.com"), []);
  assert.deepEqual(why("Email dave@smith.co.uk"), ["No email addresses in replies (found dave@smith.co.uk)."]);
});
test("promises only in the exact guarantee wording", () => {
  assert.deepEqual(why("Guaranteed more calls."), ["Promises must use the exact guarantee wording from the offer."]);
  assert.deepEqual(why("Top 3 in Google search results in 90 days. GUARANTEED."), []);
});
test("weekend deal only at the weekend", () => {
  assert.deepEqual(why("The first 90 days free."), ["The weekend deal isn't on when this goes out: use the weekday offer."]);
  assert.deepEqual(why("The first 90 days free.", { ...CTX, offer: offerFacts(new Date("2026-10-24T10:00:00Z")) }), []);
});
test("placeholders, HTML, sign-off, empty", () => {
  assert.deepEqual(why("Here: [link]"), ["Fill in or remove the placeholder [link]."]);
  assert.deepEqual(why("Hi {name}"), ["Fill in or remove the placeholder {name}."]);
  assert.deepEqual(why("<b>Hi</b>"), ["Plain text only: remove the HTML."]);
  assert.deepEqual(why("Sure.\n\nThanks,\nNik"), ["Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply."]);
  assert.deepEqual(why("  "), ["Write a reply, or escalate."]);
});

// ---- Beyond the plan's list: bypasses and false alarms (Review Focus 5) ----

test("REPLY_HOSTS is the spec's list", () => assert.deepEqual(REPLY_HOSTS, ["aetoswebsites.com", "www.aetoswebsites.com"]));

test("hosts must match exactly, however the link is dressed up", () => {
  const host = (h) => [`Links can only go to their demo, their order page or aetoswebsites.com (found ${h}).`];
  assert.deepEqual(why("https://aetoswebsites.com.evil.io/d/green-leaf-ab12"), host("aetoswebsites.com.evil.io"));
  assert.deepEqual(why("https://aetoswebsites.com@bit.ly/x"), host("bit.ly"));
  assert.deepEqual(why("http://evilaetoswebsites.com"), host("evilaetoswebsites.com"));
  assert.deepEqual(why("See BIT.LY/x."), host("bit.ly"));
  assert.deepEqual(why("Our site: evil.xyz/page"), host("evil.xyz"));
  assert.deepEqual(why("https://AetosWebsites.com/d/green-leaf-ab12."), []);
  assert.deepEqual(why("(https://aetoswebsites.com/d/green-leaf-ab12)"), []);
  assert.deepEqual(why("aetoswebsites.com/d/green-leaf-ab12/order"), []);
  // two bad hosts are named together, once
  assert.deepEqual(why("bit.ly/a and tinyurl.com/b and bit.ly/c"), host("bit.ly, tinyurl.com"));
});

test("an email address is not also a bad host; ordinary writing is no link", () => {
  assert.deepEqual(why("Write to Dave.Smith@smith.co.uk please"), ["No email addresses in replies (found Dave.Smith@smith.co.uk)."]);
  assert.deepEqual(why("e.g. St.Albans at 11 a.m. costs £1,950.00 i.e. the U.K. price."), []);
});

test("another lead's demo: with no slug every demo link is refused, bare too", () => {
  assert.deepEqual(why("aetoswebsites.com/d/other-slug/order"), ["That link is another business's demo (/d/other-slug)."]);
  assert.deepEqual(why("https://aetoswebsites.com/d/green-leaf-ab12", { ...CTX, slug: null }), ["That link is another business's demo (/d/green-leaf-ab12)."]);
});

test("more price bypasses", () => {
  const full = ["Write prices in full with £, e.g. £1,950."];
  for (const b of ["£2k", "£ 1.5k", "2.5K up front", "GBP 1950", "about 2 grand", "a few hundred pounds"]) assert.deepEqual(why(b), full, b);
  assert.deepEqual(why("£ 1,950 and £249"), []);
  assert.deepEqual(why("£249.50"), ["£249.50 isn't one of our prices (£249, £1,750, £1,950)."]);
  assert.deepEqual(why("£1,500 or £2,000 or £1,500"), ["£1,500 and £2,000 aren't our prices (£249, £1,750, £1,950)."]);
});

test("more SEO bypasses, and words that only look like it", () => {
  const seo = ["Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\"."];
  for (const b of ["S.E.O.", "S​EO", "search engine optimisation", "#SEO"]) assert.deepEqual(why(b), seo, b);
  for (const b of ["Seoul trip", "the CEO", "museo"]) assert.deepEqual(why(b), [], b);
});

test("promise words outside the guarantee sentences", () => {
  const p = ["Promises must use the exact guarantee wording from the offer."];
  for (const b of ["I promise you'll love it.", "100% sure.", "Money-back if not.", "Website live in 7 days, GUARANTEED. And a guarantee on calls."]) assert.deepEqual(why(b), p, b);
  for (const g of WEEKDAY.guarantees) assert.deepEqual(why(`Good question. ${g.toLowerCase()}`), [], g);
});

test("weekend wording variants", () => {
  const w = ["The weekend deal isn't on when this goes out: use the weekday offer."];
  for (const b of ["90 days free", "free for the first 90 days", "the first 90 days are on us"]) assert.deepEqual(why(b), w, b);
  assert.deepEqual(why("The first 60 days are free."), []);
});

test("sign-off variants", () => {
  const s = ["Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply."];
  for (const b of ["Sure.\nAetos Websites", "Sure.\n\nCheers, Nik", "Sure.\n- Nik.", "Sure.\nNik\n\n"]) assert.deepEqual(why(b), s, JSON.stringify(b));
  assert.deepEqual(why("Sure.\nNikiforos", { ...CTX, signName: "Nikiforos" }), s);
  assert.deepEqual(why("Speak soon, and thanks Nik for asking."), []);
});

test("reasons come in the table's order, each once", () => {
  const body = `<p>${"word ".repeat(180)}</p> bit.ly/x a@b.co £1,500 2k SEO guaranteed 90 days free [link]\nThanks,\nNik`;
  assert.deepEqual(why(body), [
    "Too long: 193 words (180 max).",
    "Links can only go to their demo, their order page or aetoswebsites.com (found bit.ly).",
    "No email addresses in replies (found a@b.co).",
    "£1,500 isn't one of our prices (£249, £1,750, £1,950).",
    "Write prices in full with £, e.g. £1,950.",
    "Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\".",
    "Promises must use the exact guarantee wording from the offer.",
    "The weekend deal isn't on when this goes out: use the weekday offer.",
    "Fill in or remove the placeholder [link].",
    "Plain text only: remove the HTML.",
    "Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply.",
  ]);
  assert.equal(replyGuard(body, CTX).ok, false);
});

test("not a string, or a huge body, is handled quickly", () => {
  assert.deepEqual(why(undefined), ["Write a reply, or escalate."]);
  const t = Date.now();
  replyGuard("a".repeat(20000) + " " + "a-".repeat(10000) + " " + "a.".repeat(10000), CTX);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
});

// ---- Reviewer's additions: bypasses and false alarms found in review ----

test("demo links are resolved as a browser would", () => {
  const other = ["That link is another business's demo (/d/other-slug)."];
  for (const b of ["https://aetoswebsites.com/x/../d/other-slug", "https://aetoswebsites.com/d/green-leaf-ab12/../other-slug",
    "https://aetoswebsites.com/D/other-slug", "https://aetoswebsites.com//d/other-slug", "https://aetoswebsites.com/%2e%2e/d/other-slug",
    "aetoswebsites.com/x/../d/other-slug"]) assert.deepEqual(why(b), other, b);
  assert.deepEqual(why("https://aetoswebsites.com/d/green-leaf-ab12/order?x=1#top"), []);
});

test("a bare link right after @ or _ is still a link", () => {
  assert.deepEqual(why("Find us @bit.ly/x"), ["Links can only go to their demo, their order page or aetoswebsites.com (found bit.ly)."]);
  assert.deepEqual(why("a_b.bit.ly/x"), ["Links can only go to their demo, their order page or aetoswebsites.com (found b.bit.ly)."]);
});

test("an email address spelt out is still an address", () => {
  assert.deepEqual(why("dave at smith dot co dot uk"), ["No email addresses in replies (found dave at smith dot co dot uk)."]);
  assert.deepEqual(why("dave(at)smith(dot)com"), ["No email addresses in replies (found dave(at)smith(dot)com)."]);
  for (const b of ["Look at the site.", "I'll call you at 11am on Tuesday at your office."]) assert.deepEqual(why(b), [], b);
});

test("price bypasses: spacing, ₤, millions, no £", () => {
  const wrong = ["£1,500 isn't one of our prices (£249, £1,750, £1,950)."];
  for (const b of ["It's £  1,500.", "£ 1,500", "₤1,500"]) assert.deepEqual(why(b), wrong, JSON.stringify(b));
  const full = ["Write prices in full with £, e.g. £1,950."];
  for (const b of ["£2m", "It's 1,950 for the site then 249 a month.", "249 per month", "1950 up front", "1500£"]) assert.deepEqual(why(b), full, b);
  for (const b of ["I'll call at 12pm.", "Over 1,000 searches a month for roofers in your town.", "in 2025 we built 30 sites"]) assert.deepEqual(why(b), [], b);
});

test("SEO in lookalike letters or with wider gaps", () => {
  const seo = ["Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\"."];
  for (const b of ["ЅЕО", "S - E - O", "SE0 work"]) assert.deepEqual(why(b), seo, b);
});

test("promise words are whole-word: compromise is fine", () => {
  assert.deepEqual(why("We never compromise on quality."), []);
  assert.deepEqual(why("We promise."), ["Promises must use the exact guarantee wording from the offer."]);
});

test("the weekend's 90 days in other words", () => {
  const w = ["The weekend deal isn't on when this goes out: use the weekday offer."];
  for (const b of ["90 free days", "90 days for free", "3 months free", "free for the first three months"]) assert.deepEqual(why(b), w, b);
  for (const b of ["90 free days", "3 months free"]) assert.deepEqual(why(b, { ...CTX, offer: offerFacts(new Date("2026-10-25T10:00:00Z")) }), [], b);
});

test("a long hostile body stays fast", () => {
  const t = Date.now();
  replyGuard(("x at ".repeat(2000)) + ("£ ".repeat(2000)) + ("s.".repeat(3000)) + ("1".repeat(5000)), CTX);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
});

test("weekdays: £1,750 with the monthly price is the weekend Full Package price, refused; both packages named pass", () => {
  const WEEKEND = { ...CTX, offer: offerFacts(new Date("2026-10-24T10:00:00Z")) };
  const WHY = "£1,750 is the Website Only price; the Full Package is £1,950 to build.";
  for (const b of [
    "It's £1,750 to build, then £249 a month.",
    "£1,750 up front and £249/month after that.",
    "It's £1,750 to build and then a small fee per month.",
    "Just £1,750, then it's monthly.",
  ]) assert.deepEqual(why(b), [WHY], b);
  // the same words at the weekend are the weekend deal
  assert.deepEqual(why("It's £1,750 to build, then £249 a month.", WEEKEND), []);
  // both packages named
  assert.deepEqual(why("The Full Package is £1,950 to build, then £249 a month. The website on its own is £1,750 one-off."), []);
  // Website Only on its own, with nothing monthly
  assert.deepEqual(why("The website on its own is £1,750 one-off, with no monthly fee."), []);
  assert.deepEqual(why("Just the website is £1,750, nothing monthly."), []);
  assert.deepEqual(why("It's £1,750 for the website only."), []);
});

test("the weekday £1,750 reason comes after the weekend one, as in Part A's table", () => {
  assert.deepEqual(why("It's £1,750 to build, then £249 a month. SEO guaranteed, first 90 days free. [link]"), [
    "Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\".",
    "Promises must use the exact guarantee wording from the offer.",
    "The weekend deal isn't on when this goes out: use the weekday offer.",
    "£1,750 is the Website Only price; the Full Package is £1,950 to build.",
    "Fill in or remove the placeholder [link].",
  ]);
});

// ---- Second review: bypasses that put a wrong price or the weekend deal in front of a prospect ----

test("a price with no £ at all, another currency, or a sign before the digits isn't in full", () => {
  const full = ["Write prices in full with £, e.g. £1,950."];
  for (const b of ["It's 1500 to build.", "That's 1,500 for the website.", "It costs 1500.", "You'd pay 1,950 for the site.",
    "$1,500", "€1500", "1500 dollars", "USD 1500", "£-1500", "£~1,500", "£(1500)"]) assert.deepEqual(why(b), full, b);
  for (const b of ["It costs nothing for 60 days.", "Over 1,000 searches a month for roofers in your town.",
    "Your site would be one of 300 roofers in the area.", "I'll pay 100% attention", "Call me on 01234 567890."]) {
    assert.deepEqual(why(b).filter((r) => r === full[0]), [], b);
  }
});

test("the weekend's 90 free days in yet more words", () => {
  const w = ["The weekend deal isn't on when this goes out: use the weekday offer."];
  for (const b of ["90-day free trial", "a free 90 days", "3 months on us", "the first three months at no cost", "90 days at no cost",
    "Pay nothing for 90 days.", "nothing to pay for ninety days"]) {
    assert.deepEqual(why(b), w, b);
    assert.deepEqual(why(b, { ...CTX, offer: offerFacts(new Date("2026-10-24T10:00:00Z")) }), [], `${b} (weekend)`);
  }
  // the weekday's own 60 days, and the 90-day ranking promise near "free" in another clause, are no weekend deal
  for (const b of ["Your first 60 days are free, and you'd be in the top 3 on Google in 90 days.", "The first 60 days are free.",
    "If you're not in the top 3 of Google results within 90 days, we keep working until you are.",
    "In the first 3 months most clients see more calls."]) assert.deepEqual(why(b), [], b);
});

test("a sign-off with a surname under a closing line, and links with other common endings", () => {
  const s = ["Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply."];
  for (const b of ["Sure.\n\nBest,\nNik Smith", "Sure.\nThanks\nNik P."]) assert.deepEqual(why(b), s, JSON.stringify(b));
  assert.deepEqual(why("Sure, that works.\nNik will call you on Tuesday."), []);
  assert.deepEqual(why("Visit Evil.Click today"), ["Links can only go to their demo, their order page or aetoswebsites.com (found evil.click)."]);
});

test("3 days or 90 months free is no weekend deal, and the new checks stay fast", () => {
  assert.deepEqual(why("The demo stays up 3 days free of charge."), []);
  const t = Date.now();
  replyGuard(("free " + " ".repeat(300) + "x ").repeat(10) + "costs " + "1".repeat(3000) + "£" + " ".repeat(3000) + "$", CTX);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
});

// ---- Third review: false alarms on good replies, and percent-encoded demo links ----

test("a £ amount written with a space is checked as a price, not refused as 'not in full'", () => {
  for (const b of ["£ 249 a month", "£ 1950 one-off", "£ 1,950 to build, then £ 249 per month."]) assert.deepEqual(why(b), [], b);
  assert.deepEqual(why("£ 1500 to build"), ["£1,500 isn't one of our prices (£249, £1,750, £1,950)."]);
  assert.deepEqual(why("1500 to build"), ["Write prices in full with £, e.g. £1,950."]);
});

test("percent-encoded demo links are read decoded", () => {
  const other = ["That link is another business's demo (/d/other-slug)."];
  for (const b of ["https://aetoswebsites.com/%64/other-slug", "https://aetoswebsites.com/d%2fother-slug",
    "https://aetoswebsites.com/d/green-leaf-ab12%2F..%2Fother-slug"]) assert.deepEqual(why(b), other, b);
  assert.deepEqual(why("https://aetoswebsites.com/d/green%2Dleaf-ab12"), []);
  assert.deepEqual(why("https://aetoswebsites.com/d/green-leaf-ab12%"), ["That link is another business's demo (/d/green-leaf-ab12%)."]);
});

test("a sentence starting with the name under a closing word isn't a sign-off; 'Aetos Websites Team' is", () => {
  assert.deepEqual(why("Sure, that works. Thanks!\nNik will call you on Tuesday"), []);
  assert.deepEqual(why("Sure.\nRegards,\nAetos Websites Team"), ["Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply."]);
});

// ---- Fixer: "free" as in "you're free" or "we work free until you are" is no weekend deal ----

test("weekdays: the guarantee and 'check back in 3 months' wording aren't the weekend deal", () => {
  for (const b of [
    "If you're not in the top 3 on Google in 90 days, we work free until you are.",
    "Top 3 on Google within 90 days, or it's free until you are.",
    "No worries. Is it OK if I check back in 3 months, if you're free then?",
    "That's fine. If you're free in 3 months I'll drop you a line.",
    "Are you free in 3 months for a quick chat?",
    "Would you be free for a chat in 3 months?",
    "If you're not top 3 within 90 days, it's free work until you are.",
  ]) assert.deepEqual(why(b), [], b);
  const w = ["The weekend deal isn't on when this goes out: use the weekday offer."];
  for (const b of ["a free 90 days", "3 months on us", "pay nothing for 90 days", "90-day free trial", "90 days free"]) {
    assert.deepEqual(why(b), w, b);
  }
});
