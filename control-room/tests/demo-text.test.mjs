// Demo safe text helpers (pure). Run: node --test control-room/tests/demo-text.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cleanText, h, safeHttps, shortAuthor, shortName, slugFor, telHref } from "../functions/_lib/demo/text.js";
import * as oldDemo from "../functions/_lib/demo.js";

test("h() escapes HTML and removes control and bidi characters", () => {
  assert.equal(h(`<a href="x">'&\``), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;");
  assert.equal(h("Smith‮ gnifooR\u0007"), "Smith gnifooR");          // bidi + control chars removed
  assert.equal(h(null), "");
  assert.equal(h(undefined), "");
  assert.equal(h(4.8), "4.8");
  assert.equal(h("a\u202Ab\u202Bc\u202Cd\u202De\u202Ef\u2066g\u2067h\u2068i\u2069j\u0000k\u001Fl\u007Fm\u000Bn\u000Co"), "abcdefghijklmno");
  assert.equal(h("line one\nline two\tend"), "line one\nline two\tend"); // ordinary whitespace kept
});

test("cleanText collapses whitespace and clips at a word with …", () => {
  assert.equal(cleanText("  a   b\n c ", 100), "a b c");
  assert.equal(cleanText("one two three four", 9), "one two…");
  assert.equal(cleanText("one two three four", 18), "one two three four"); // fits exactly: no cut
  assert.ok(cleanText("one two three four", 9).length <= 9);
  assert.equal(cleanText("abcdefghijkl", 6), "abcde…");                 // one long word: hard cut
  assert.equal(cleanText(null, 10), "");
  assert.equal(cleanText("Smith\u202E\u0007 Roofing", 100), "Smith Roofing");
  assert.equal(cleanText("Great work… really pleased", 12), "Great work…");        // never a double "……"
  assert.equal(cleanText("Patios, decking, fencing", 17), "Patios, decking…");      // no ",…"
  assert.equal(cleanText("a" + "!".repeat(698) + "bc", 700), "a…");               // a long punctuation run is dropped
});

test("safeHttps lets through only plain https URLs", () => {
  assert.equal(safeHttps("https://ex.co.uk/a.jpg"), "https://ex.co.uk/a.jpg");
  for (const bad of ["http://ex.co.uk/a.jpg", "javascript:alert(1)", 'https://x.co/a.jpg" onerror="x', "https://x.co/a(1).jpg", "//x.co/a.jpg", "https://x.co/" + "a".repeat(2050)])
    assert.equal(safeHttps(bad), "");
  for (const bad of [null, undefined, "", "https://", "https://x.co/a'b.jpg", "https://x.co/a<b", "https://x.co/a\\b", "https://x.co/a b.jpg", "data:image/png;base64,AAA"])
    assert.equal(safeHttps(bad), "");
  for (const bad of ["https://x.co/a\u202E.jpg", "https://x.co/a\u0000.jpg", "https://x.co/a.jpg\nonerror=x", "HTTPS://x.co/a.jpg", "https://x.co/a.jpg\\"])
    assert.equal(safeHttps(bad), "");
  const long = "https://x.co/" + "a".repeat(2048 - 13);
  assert.equal(long.length, 2048);
  assert.equal(safeHttps(long), long);                                  // 2048 is the limit, inclusive
  assert.equal(safeHttps(long + "a"), "");
});

test("telHref keeps a leading + and the digits, only for 10-13 digits", () => {
  assert.equal(telHref("07969 770905"), "07969770905");
  assert.equal(telHref("+44 7969 770905"), "+447969770905");
  assert.equal(telHref("<b>0800</b>"), "");
  assert.equal(telHref("01925 12345"), "0192512345");                   // 10 digits
  assert.equal(telHref("+44 1925 123 456 7"), "+4419251234567");       // 13 digits
  assert.equal(telHref("+44 1925 123 456 78"), "");                     // 14 digits
  assert.equal(telHref("01925 1234"), "");                              // 9 digits
  assert.equal(telHref(null), "");
});

test("shortName and shortAuthor", () => {
  assert.equal(shortName("DIAMOND KICKBOXING ACADEMY LTD"), "Diamond Kickboxing Academy");
  assert.equal(shortName("Green Leaf Landscapes - Garden Design | Leeds"), "Green Leaf Landscapes");
  assert.equal(shortAuthor("Sarah Jane Kent"), "Sarah K.");
  assert.equal(shortAuthor(""), "Google reviewer");
  assert.equal(shortAuthor(null), "Google reviewer");
  assert.equal(shortAuthor("   "), "Google reviewer");
  assert.equal(shortAuthor("Sarah"), "Sarah");
  assert.equal(shortAuthor("Amy L."), "Amy L.");                        // already short: unchanged
  assert.equal(shortAuthor("tom hill"), "tom H.");
});

test("slugFor is readable and unguessable", () => {
  assert.match(slugFor("Smith & Sons Roofing Ltd"), /^smith-and-sons-roofing-[a-hj-km-np-z2-9]{6}$/);
  assert.equal(slugFor("Smith Roofing", () => 0), "smith-roofing-aaaaaa");
  assert.notEqual(slugFor("Smith"), slugFor("Smith"));
  assert.match(slugFor(""), /^your-business-[a-hj-km-np-z2-9]{6}$/);
  assert.ok(slugFor("A".repeat(80) + " Roofing").length <= 40 + 7);
});

test("_lib/demo.js re-exports shortName and slugFor from demo/text.js", () => {
  assert.equal(oldDemo.shortName, shortName);
  assert.equal(oldDemo.slugFor, slugFor);
});

test("text.js has no literal bidi characters (they hide what code says)", () => {
  const src = readFileSync(new URL("../functions/_lib/demo/text.js", import.meta.url), "utf8");
  assert.equal(/[\u202A-\u202E\u2066-\u2069]/.test(src), false);
});
