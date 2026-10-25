// First email (pure): the greeting rule, the text checks before Send (exact messages from Part A §A3), the text the
// prospect gets (greeting, Nik's body with the demo link, the cold footer) and taking the footer off again.
// Run: node --test control-room/tests/rules.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { OPT_OUT_LINE, coldFooter } from "../functions/_lib/mail/compose.js";
import { firstEmailIssues, greetingFor, renderFirstEmail, stripFooter } from "../functions/_lib/mail/rules.js";

// The plan's tests (Task 5, Step 1), word for word.
const demoUrl = "https://aetoswebsites.com/d/green-leaf";
const ok = { subject: "Your website", body: "I made you a site: {demo_link}\nHave a look.", demoUrl };
const codes = (x) => firstEmailIssues({ ...ok, ...x }).map((i) => i.code);
test("greeting rule", () => {
  assert.deepEqual(greetingFor({ first: "mark", confident: true }), { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(greetingFor({ first: "Mark", confident: false }), { line: "Hi,", name: null });
  assert.deepEqual(greetingFor(null), { line: "Hi,", name: null });
});
test("clean email passes", () => assert.deepEqual(codes({}), []));
test("each check", () => {
  assert.deepEqual(codes({ subject: " " }), ["subject_missing"]);
  assert.deepEqual(codes({ subject: "Re: your site" }), ["subject_re"]);
  assert.deepEqual(codes({ body: "Hi Mark,\nI made you a site: {demo_link}" }), ["greeting"]);
  assert.deepEqual(codes({ body: "No link here" }), ["demo_missing"]);
  assert.deepEqual(codes({ body: `{demo_link} ${demoUrl}` }), ["demo_twice"]);
  assert.deepEqual(codes({ body: `Here: ${demoUrl}` }), []);                       // raw URL pasted counts as the link
  assert.deepEqual(codes({ body: "{demo_link}\n--\nNik | www.aetoswebsites.com" }), ["other_link"]);
  assert.deepEqual(codes({ body: "{demo_link} or email nik@aetoswebsites.com" }), ["other_link"]);
  assert.deepEqual(codes({ body: "{demo_link} better seo" }), ["seo"]);
  assert.deepEqual(codes({ body: `{demo_link} ${"word ".repeat(149)}` }), ["too_long"]);
  assert.deepEqual(codes({ body: `{demo_link} ${"word ".repeat(148)}` }), []);
  assert.deepEqual(codes({ body: "{demo_link} for {business}" }), ["placeholder"]);
  assert.deepEqual(codes({ body: "I’ve made you a site “for you”: {demo_link}" }), []);
});
test("messages are plain English", () => assert.equal(
  firstEmailIssues({ ...ok, body: "{demo_link} see greenleaf.co.uk" })[0].message, "Only the demo link is allowed. Remove: greenleaf.co.uk"));
test("render + strip footer", () => {
  const text = renderFirstEmail({ greetingLine: "Hi,", body: "  Look: {demo_link}  ", demoUrl, nikName: "Nik" });
  assert.ok(text.startsWith(`Hi,\n\nLook: ${demoUrl}\n\n`));
  assert.ok(text.endsWith(coldFooter("Nik")));
  assert.equal(stripFooter(text, "Nik"), `Hi,\n\nLook: ${demoUrl}`);
});

// Beyond the plan's tests.
const issues = (x) => firstEmailIssues({ ...ok, ...x });
const messages = (x) => issues(x).map((i) => i.message);

test("every text check's message, exactly as in Part A §A3", () => {
  assert.deepEqual(issues({ subject: "" }), [{ code: "subject_missing", message: "Add a subject." }]);
  assert.deepEqual(issues({ subject: "Fwd: your site" }),
    [{ code: "subject_re", message: 'The subject can\'t start with "Re:" or "Fwd:".' }]);
  assert.deepEqual(issues({ body: "" }), [{ code: "body_missing", message: "Write the email first." }]);
  assert.deepEqual(issues({ body: "Hello there,\n{demo_link}", greetingLine: "Hi Mark," }),
    [{ code: "greeting", message: 'Leave out the greeting: "Hi Mark," is added for you.' }]);
  assert.deepEqual(issues({ body: "No link here" }),
    [{ code: "demo_missing", message: "Add the demo link: press Insert demo link." }]);
  assert.deepEqual(issues({ body: "{demo_link} and {demo_link}" }),
    [{ code: "demo_twice", message: "The demo link is in there more than once. Keep it once." }]);
  assert.deepEqual(issues({ body: "{demo_link} see www.x.com" }),
    [{ code: "other_link", message: "Only the demo link is allowed. Remove: www.x.com" }]);
  assert.deepEqual(issues({ body: "{demo_link} better SEO" }),
    [{ code: "seo", message: 'Don\'t say "SEO". Say "front page of Google" instead.' }]);
  assert.deepEqual(issues({ body: `{demo_link} ${"word ".repeat(160)}` }),
    [{ code: "too_long", message: "Too long: 161 words. Keep it under 150." }]);
  assert.deepEqual(issues({ body: "{demo_link} for {business}" }),
    [{ code: "placeholder", message: "{business} isn't filled in for you. Only {demo_link} is." }]);
});

test("the greeting message quotes the greeting the email gets", () => {
  assert.deepEqual(messages({ body: "Hi,\n{demo_link}", greetingLine: "Hi," }),
    ['Leave out the greeting: "Hi," is added for you.']);
  assert.deepEqual(messages({ body: "Hi,\n{demo_link}" }), ['Leave out the greeting: "Hi," is added for you.']); // no name given
});

test("subject: Re / Fwd / Fw in any case, with spaces; a word that only starts the same is fine", () => {
  for (const subject of ["Re: x", "RE: x", "re:x", "  Re : x", "Fwd: x", "FWD: x", "Fw: x", "fw:x"]) {
    assert.deepEqual(codes({ subject }), ["subject_re"], subject);
  }
  for (const subject of ["Regarding your site", "Re-opening soon", "Free website for you", "Few changes"]) {
    assert.deepEqual(codes({ subject }), [], subject);
  }
  assert.deepEqual(codes({ subject: "\u00a0\t" }), ["subject_missing"]); // a non-breaking space is blank too
  assert.deepEqual(codes({ subject: null }), ["subject_missing"]);
  assert.deepEqual(codes({ subject: undefined }), ["subject_missing"]);
});

test("a blank body is only 'Write the email first.'", () => {
  for (const body of ["", "   ", "\n\n  \n", null, undefined]) assert.deepEqual(codes({ body }), ["body_missing"]);
  assert.deepEqual(codes({ subject: "", body: "" }), ["subject_missing", "body_missing"]);
});

test("greeting: only the body's first line, only greeting words", () => {
  for (const first of ["Hi Mark,", "hi,", "HI MARK", "Hiya Mark,", "Hello,", "Hello!", "Hey there", "Dear Mark",
    "Morning Mark,", "Morning,", "Good morning,", "Good  Morning Mark", "Good afternoon,", "Good evening Mark,", "Hi\u00a0Mark,"]) {
    assert.deepEqual(codes({ body: `${first}\nI made you a site: {demo_link}` }), ["greeting"], first);
  }
  assert.deepEqual(codes({ body: "\n\n  Hi Mark,\n{demo_link}" }), ["greeting"]); // leading blank lines don't hide it
  for (const first of ["Highly rated on Google, and I made you a site:", "History is", "Heyday", "Hi-vis and all",
    "Goodness,", "Dearest", "I said hi to Mark"]) {
    assert.deepEqual(codes({ body: `${first}\n{demo_link}` }), [], first);
  }
  assert.deepEqual(codes({ body: "I made you a site: {demo_link}\nHi again later" }), []); // not the first line
});

test("the demo link: {demo_link} and the pasted demo address count together", () => {
  assert.deepEqual(codes({ body: `Here: ${demoUrl}.` }), []); // a full stop after it isn't part of it
  assert.deepEqual(codes({ body: `Here (${demoUrl})` }), []);
  assert.deepEqual(codes({ body: `Here: “${demoUrl}”` }), []);
  assert.deepEqual(codes({ body: `Here: <${demoUrl}>` }), []);
  assert.deepEqual(codes({ body: "Look: {demo_link}." }), []);
  assert.deepEqual(codes({ body: `${demoUrl}\n${demoUrl}` }), ["demo_twice"]);
  assert.deepEqual(codes({ body: "{demo_link}{demo_link}" }), ["demo_missing", "other_link"]); // glued: one dead link
  // A demo address that isn't this lead's own (the order page, another slug) is another link, and not the demo link.
  assert.deepEqual(codes({ body: `Order: ${demoUrl}/order` }), ["demo_missing", "other_link"]);
  assert.deepEqual(codes({ body: "Look: https://aetoswebsites.com/d/green-leaf-landscapes" }), ["demo_missing", "other_link"]);
  assert.deepEqual(codes({ body: "Look: aetoswebsites.com/d/green-leaf" }), ["demo_missing", "other_link"]);
});

test("the demo link glued to other text would be a dead link, so it doesn't count", () => {
  assert.deepEqual(messages({ body: "Look: {demo_link}thanks" }), ["Add the demo link: press Insert demo link.",
    `Only the demo link is allowed. Remove: ${demoUrl}thanks`]);
  assert.deepEqual(codes({ body: "Look: https://{demo_link}" }), ["demo_missing", "other_link"]);
  assert.deepEqual(codes({ body: "Look: www.{demo_link}" }), ["demo_missing", "other_link"]);
});

test("other links: every way pasted text writes one, listed once each", () => {
  const found = (body) => issues({ body }).find((i) => i.code === "other_link")?.message;
  assert.equal(found("{demo_link}\nNik | www.aetoswebsites.com | nik@aetoswebsites.com | www.aetoswebsites.com"),
    "Only the demo link is allowed. Remove: www.aetoswebsites.com, nik@aetoswebsites.com");
  assert.equal(found("{demo_link} or https://greenleaf.co.uk/about."), "Only the demo link is allowed. Remove: https://greenleaf.co.uk/about");
  assert.equal(found("{demo_link} (greenleaf.co.uk)"), "Only the demo link is allowed. Remove: greenleaf.co.uk");
  assert.equal(found("{demo_link} “greenleaf.co.uk”"), "Only the demo link is allowed. Remove: greenleaf.co.uk");
  // Ordinary writing isn't a link.
  for (const body of ["{demo_link} e.g. a new site. Ok.", "{demo_link} It's £1,950.00 all in.", "{demo_link} 9.30am",
    "{demo_link} St.Albans", "{demo_link} I’m “sure”."]) {
    assert.equal(found(body), undefined, body);
  }
});

test("a link without a demo address to compare: every link is another link, {demo_link} still counts", () => {
  assert.deepEqual(codes({ demoUrl: null, body: "Look: {demo_link}" }), []);
  assert.deepEqual(codes({ demoUrl: "", body: "Look: {demo_link} {demo_link}" }), ["demo_twice"]);
  assert.deepEqual(codes({ demoUrl: undefined, body: `Look: ${demoUrl}` }), ["demo_missing", "other_link"]);
});

test("SEO: as a word, any case, subject or body; not inside the demo address or another word", () => {
  assert.deepEqual(codes({ subject: "Your SEO" }), ["seo"]);
  assert.deepEqual(codes({ body: "{demo_link} Seo." }), ["seo"]);
  assert.deepEqual(codes({ body: "{demo_link} the SEO’s fine" }), ["seo"]);
  assert.deepEqual(codes({ subject: "SEO", body: "{demo_link} and SEO" }).filter((c) => c === "seo"), ["seo"]); // once
  assert.deepEqual(codes({ body: "{demo_link} from Seoul" }), []);
  const seoUrl = "https://aetoswebsites.com/d/seo-roofing-x1y2z3";
  assert.deepEqual(codes({ demoUrl: seoUrl, body: `Look: ${seoUrl}` }), []);
});

test("too long: 150 words or more, {demo_link} and the pasted address count 1 each", () => {
  assert.deepEqual(codes({ body: `${demoUrl} ${"word ".repeat(149)}` }), ["too_long"]);
  assert.deepEqual(codes({ body: `${demoUrl} ${"word ".repeat(148)}` }), []);
  assert.deepEqual(codes({ body: `{demo_link}\n\n${"word\n".repeat(148)}` }), []); // line breaks separate words too
});

test("placeholders: each one named once, in braces whatever the case or spacing; the subject too", () => {
  assert.deepEqual(messages({ body: "{demo_link} {business} in {town}, {business}" }), [
    "{business} isn't filled in for you. Only {demo_link} is.",
    "{town} isn't filled in for you. Only {demo_link} is.",
  ]);
  assert.deepEqual(messages({ body: "{Demo_Link}" }), ["Add the demo link: press Insert demo link.",
    "{Demo_Link} isn't filled in for you. Only {demo_link} is."]);
  assert.deepEqual(codes({ body: "{demo_link} { business }" }), ["placeholder"]);
  assert.deepEqual(messages({ subject: "A site for {business}" }), ["{business} isn't filled in for you. Only {demo_link} is."]);
  assert.deepEqual(messages({ subject: "Your site {demo_link}" }), ["{demo_link} only works in the email, not in the subject."]);
});

test("pasted from Word: Windows line ends, Word's line breaks and non-breaking spaces", () => {
  assert.deepEqual(codes({ body: "I made you a site:\r\n{demo_link}\r\nHave a look." }), []);
  assert.deepEqual(codes({ body: "Hi Mark,\u000bI made you a site: {demo_link}" }), ["greeting"]); // Word's Shift+Enter
  assert.deepEqual(codes({ body: "I made you a site:\u00a0{demo_link}" }), []);
});

test("issues come in the A3 order", () => {
  assert.deepEqual(codes({ subject: "Re: SEO", body: `Hi,\n{business} ${"word ".repeat(150)} www.x.com` }),
    ["subject_re", "greeting", "demo_missing", "other_link", "seo", "too_long", "placeholder"]);
});

test("firstEmailIssues refuses what isn't text, in plain English", () => {
  assert.throws(() => firstEmailIssues({ ...ok, body: 42 }), { name: "TypeError", message: /email's text/ });
  assert.throws(() => firstEmailIssues({ ...ok, subject: {} }), { name: "TypeError", message: /subject/ });
  assert.throws(() => firstEmailIssues(null), { name: "TypeError" });
});

test("greetingFor: a confident first name only, title-cased, else Hi,", () => {
  const g = (owner) => greetingFor(owner);
  assert.deepEqual(g({ first: "MARK", confident: true }), { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(g({ first: "  mark ", confident: true }), { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(g({ first: "mary-jane", confident: true }), { line: "Hi Mary-Jane,", name: "Mary-Jane" });
  assert.deepEqual(g({ first: "JEAN-LUC", confident: true }), { line: "Hi Jean-Luc,", name: "Jean-Luc" });
  assert.deepEqual(g({ first: "DeShawn", confident: true }), { line: "Hi DeShawn,", name: "DeShawn" }); // mixed case kept
  assert.deepEqual(g({ first: "d’arcy", confident: true }), { line: "Hi D’arcy,", name: "D’arcy" });
  assert.deepEqual(g({ first: "zoë", confident: true }), { line: "Hi Zoë,", name: "Zoë" });
  assert.deepEqual(g({ first: "Jose\u0301", confident: true }).name, "José"); // NFC, as research stores it
  for (const owner of [undefined, {}, "Mark", { first: "Mark" }, { first: "Mark", confident: "true" },
    { first: "Mark", confident: 1 }, { first: "", confident: true }, { first: "  ", confident: true },
    { first: null, confident: true }, { first: 7, confident: true }, { first: "Mark Smith", confident: true },
    { first: "Mark\nBuy now", confident: true }, { first: "M4rk", confident: true }, { first: "-", confident: true },
    { first: "A".repeat(31), confident: true }, { first: "Ma\u202erk", confident: true }]) {
    assert.deepEqual(g(owner), { line: "Hi,", name: null }, JSON.stringify(owner));
  }
});

test("renderFirstEmail: greeting, blank line, Nik's body, blank line, the cold footer", () => {
  const text = renderFirstEmail({ greetingLine: "Hi Mark,", body: "\n\nI made you a site: {demo_link}\nHave a look.\n\n",
    demoUrl, nikName: "Nik" });
  assert.equal(text, `Hi Mark,\n\nI made you a site: ${demoUrl}\nHave a look.\n\n${coldFooter("Nik")}`);
  assert.ok(text.endsWith(OPT_OUT_LINE));
});

test("renderFirstEmail: the pasted demo address stays, Windows and Word line ends become \\n", () => {
  assert.equal(renderFirstEmail({ greetingLine: "Hi,", body: `Look:\r\n${demoUrl}\u000bThanks`, demoUrl, nikName: "Nik" }),
    `Hi,\n\nLook:\n${demoUrl}\nThanks\n\n${coldFooter("Nik")}`);
});

test("renderFirstEmail: values go in as they are, never read as replacement patterns", () => {
  const odd = "https://aetoswebsites.com/d/a$&b";
  assert.equal(renderFirstEmail({ greetingLine: "Hi,", body: "{demo_link}", demoUrl: odd, nikName: "Nik" }),
    `Hi,\n\n${odd}\n\n${coldFooter("Nik")}`);
});

test("renderFirstEmail: the greeting is one line; a missing greeting or demo address throws in plain English", () => {
  assert.ok(renderFirstEmail({ greetingLine: " Hi\nMark, ", body: "x", demoUrl, nikName: "Nik" }).startsWith("Hi Mark,\n\nx\n\n"));
  assert.throws(() => renderFirstEmail({ greetingLine: "", body: "x", demoUrl, nikName: "Nik" }), /greeting line/);
  assert.throws(() => renderFirstEmail({ body: "x", demoUrl, nikName: "Nik" }), /greeting line/);
  for (const bad of [null, undefined, "", " ", "/d/green-leaf", "aetoswebsites.com/d/x", "https://a.com/d/x y"]) {
    assert.throws(() => renderFirstEmail({ greetingLine: "Hi,", body: "{demo_link}", demoUrl: bad, nikName: "Nik" }),
      /demo's address/, String(bad));
  }
  // No {demo_link} in the body: no demo address is needed.
  assert.equal(renderFirstEmail({ greetingLine: "Hi,", body: "x", demoUrl: null, nikName: "Nik" }), `Hi,\n\nx\n\n${coldFooter("Nik")}`);
  assert.throws(() => renderFirstEmail({ greetingLine: "Hi,", body: 5, demoUrl, nikName: "Nik" }), TypeError);
});

test("stripFooter: takes the cold footer off the end, whatever line ends it was stored with", () => {
  const text = renderFirstEmail({ greetingLine: "Hi Mark,", body: "Look: {demo_link}", demoUrl, nikName: "Nik" });
  assert.equal(stripFooter(text, "Nik"), `Hi Mark,\n\nLook: ${demoUrl}`);
  assert.equal(stripFooter(`${text}\n\n`, "Nik"), `Hi Mark,\n\nLook: ${demoUrl}`);
  assert.equal(stripFooter(text.replace(/\n/g, "\r\n"), "Nik"), `Hi Mark,\n\nLook: ${demoUrl}`);
  assert.equal(stripFooter(`Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}`, "Nik"), "Hi,\n\nLook: https://d"); // Task 7's
});

test("stripFooter: a footer sent under another sender name, or none, still comes off", () => {
  assert.equal(stripFooter(`Hi,\n\nLook\n\n${coldFooter("Nikiforos")}`, "Nik"), "Hi,\n\nLook");
  assert.equal(stripFooter(`Hi,\n\nLook\n\n${coldFooter("")}`, "Nik"), "Hi,\n\nLook");
  assert.equal(stripFooter(`Hi,\n\nLook\n\n${coldFooter("")}`, ""), "Hi,\n\nLook");
  // "Big Nik" ends with "Nik": only a whole footer line comes off, never part of one.
  assert.equal(stripFooter(`Hi,\n\nLook\n\n${coldFooter("Big Nik")}`, "Nik"), "Hi,\n\nLook");
});

test("stripFooter: text without the footer is left as it is (end trimmed)", () => {
  assert.equal(stripFooter("Hi,\n\nThanks, Nik\n", "Nik"), "Hi,\n\nThanks, Nik");
  assert.equal(stripFooter(`Hi,\n\nI'd say ${OPT_OUT_LINE} is fine`, "Nik"), `Hi,\n\nI'd say ${OPT_OUT_LINE} is fine`);
  assert.equal(stripFooter("", "Nik"), "");
  assert.equal(stripFooter(null, "Nik"), "");
  assert.equal(stripFooter(coldFooter("Nik"), "Nik"), "");
});

// Review fixes.
test("invisible characters can't hide a greeting or a link, and never reach the prospect", () => {
  assert.deepEqual(codes({ body: "\u200bHi Mark,\nI made you a site: {demo_link}" }), ["greeting"]);
  assert.deepEqual(codes({ body: "\u202eHello,\n{demo_link}" }), ["greeting"]);
  assert.deepEqual(messages({ body: "{demo_link} www\u200b.x.com" }), ["Only the demo link is allowed. Remove: www.x.com"]);
  assert.deepEqual(messages({ body: "{demo_link} greenleaf\u00ad.co.uk" }),
    ["Only the demo link is allowed. Remove: greenleaf.co.uk"]); // Word's optional hyphen
  assert.deepEqual(codes({ body: "{demo_link} S\u200bEO" }), ["seo"]);
  assert.deepEqual(codes({ subject: "\u200b\u2060" }), ["subject_missing"]);
  assert.deepEqual(codes({ subject: "\ufeffRe: x" }), ["subject_re"]);
  assert.equal(renderFirstEmail({ greetingLine: "Hi,", body: "Lo\u200bok\u00ad: {demo_link}\u202e", demoUrl, nikName: "Nik" }),
    `Hi,\n\nLook: ${demoUrl}\n\n${coldFooter("Nik")}`);
  assert.equal(renderFirstEmail({ greetingLine: "Hi,", body: "Thanks 👨\u200d👩\u200d👧", demoUrl,
    nikName: "Nik" }), `Hi,\n\nThanks 👨\u200d👩\u200d👧\n\n${coldFooter("Nik")}`); // emoji keep their joiners
});

test("a web address in the subject is another link: the one link is the demo link, in the body", () => {
  assert.deepEqual(messages({ subject: "About greenleaf.co.uk" }), ["Only the demo link is allowed. Remove: greenleaf.co.uk"]);
  assert.deepEqual(codes({ subject: `Your site: ${demoUrl}` }), ["other_link"]);
  assert.deepEqual(messages({ subject: "www.x.com", body: "{demo_link} see y.org and www.x.com" }),
    ["Only the demo link is allowed. Remove: www.x.com, y.org"]); // the subject's first, each once
  assert.deepEqual(codes({ subject: "See www.x.com", body: "" }), ["body_missing", "other_link"]);
  assert.deepEqual(codes({ subject: "Your new site, Mr. Smith. Ok." }), []); // ordinary writing isn't a link
});

test("greetingFor: Caps Lock slips and a leading apostrophe are title-cased too", () => {
  assert.deepEqual(greetingFor({ first: "mARK", confident: true }), { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(greetingFor({ first: "deShawn", confident: true }), { line: "Hi Deshawn,", name: "Deshawn" });
  assert.deepEqual(greetingFor({ first: "McKenzie", confident: true }), { line: "Hi McKenzie,", name: "McKenzie" });
  assert.deepEqual(greetingFor({ first: "'mark", confident: true }), { line: "Hi 'Mark,", name: "'Mark" });
});

test("the first check in a new isolate fits in Workers' 10 ms of CPU", () => {
  // Patterns with Unicode letter classes took 10-40 ms to compile the first time they ran: over the free plan's 10 ms a
  // request, so the first preview in every new isolate could fail. CPU time (not the clock, so other tests running at
  // the same time don't count), in fresh processes, the best of 5.
  const url = new URL("../functions/_lib/mail/rules.js", import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(url)});
    const demoUrl = "https://aetoswebsites.com/d/green-leaf-x1y2z3";
    const body = "I\\u2019ve made you a site \\u201cfor you\\u201d: {demo_link}\\nIt\\u2019s quick on your phone. Nik | www.aetoswebsites.com";
    const t = process.cpuUsage();
    m.firstEmailIssues({ subject: "Your website", body, demoUrl, greetingLine: "Hi Mark," });
    m.stripFooter(m.renderFirstEmail({ greetingLine: m.greetingFor({ first: "mark", confident: true }).line, body, demoUrl, nikName: "Nik" }), "Nik");
    const used = process.cpuUsage(t);
    process.stdout.write(String((used.user + used.system) / 1000));`;
  const runs = Array.from({ length: 5 }, () => Number(execFileSync(process.execPath, ["--input-type=module", "-e", code])));
  assert.ok(Math.min(...runs) < 10, `the first call used ${runs.map((ms) => ms.toFixed(1)).join(", ")} ms of CPU`);
});
