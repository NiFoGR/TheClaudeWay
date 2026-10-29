// QR codes for the review booster card (stage 10, Task 17). Vendored qrcode-generator 1.4.4 (MIT), error correction M.
// Run: node --test control-room/tests/sites-qr.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { qrMatrix, qrSvg } from "../functions/_lib/sites/qr.js";

const L = "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4";
const FIXTURE = new URL("./fixtures/qr-review.sha256", import.meta.url);

// A 7×7 finder pattern: dark outer ring, light inner ring, dark 3×3 core.
function assertFinder(m, top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const want = ring === 3 || ring <= 1;
      assert.equal(m[top + r][left + c], want, `finder at (${top},${left}) module (${r},${c})`);
    }
  }
}

test("the review link is 79 bytes and encodes as version 5 (37×37) at ECC M", () => {
  assert.equal(new TextEncoder().encode(L).length, 79);
  const m = qrMatrix(L);
  assert.equal(m.length, 37);
  for (const row of m) {
    assert.equal(row.length, 37);
    for (const cell of row) assert.equal(typeof cell, "boolean");
  }
});

test("the three finder patterns are dark-ringed at (0,0), (0,30) and (30,0)", () => {
  const m = qrMatrix(L);
  assertFinder(m, 0, 0);
  assertFinder(m, 0, 30);
  assertFinder(m, 30, 0);
  // No finder in the bottom-right corner.
  assert.throws(() => assertFinder(m, 30, 30));
});

test("qrSvg: 4-module quiet zone viewBox, one path, no script", () => {
  const svg = qrSvg(L);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"'), svg.slice(0, 120));
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.doesNotMatch(svg, /<script/i);
  assert.ok(svg.trimEnd().endsWith("</svg>"));
});

test("qrSvg: one h1v1h-1z square per dark module, offset by the margin", () => {
  const m = qrMatrix(L);
  const dark = m.flat().filter(Boolean).length;
  const svg = qrSvg(L);
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);
  assert.match(svg, /M4 4h1v1h-1z/); // top-left finder corner at (margin, margin)
  assert.match(qrSvg(L, {margin: 2, px: 4}), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 41 41"/);
});

test("SHA-256 of qrSvg(L) equals the recorded fixture", () => {
  const want = readFileSync(FIXTURE, "utf8").trim();
  assert.match(want, /^[0-9a-f]{64}$/);
  assert.equal(createHash("sha256").update(qrSvg(L)).digest("hex"), want);
});

test("text is encoded as UTF-8 bytes: 42 × é (84 bytes) fits version 5, 43 × é (86 bytes) needs version 6", () => {
  assert.equal(qrMatrix("é".repeat(42)).length, 37);
  assert.equal(qrMatrix("é".repeat(43)).length, 41);
});

test("plain-English errors for an empty or too-long link", () => {
  for (const bad of ["", null, undefined]) {
    assert.throws(() => qrMatrix(bad), {message: "There's nothing to put in the QR code: the link is empty."});
    assert.throws(() => qrSvg(bad), {message: "There's nothing to put in the QR code: the link is empty."});
  }
  assert.throws(() => qrSvg("x".repeat(3000)), {message: "That link is too long to fit in a QR code."});
});

test("nothing from the input reaches the SVG markup; bad margin/px fall back to 4 and 8", () => {
  const svg = qrSvg('https://x.test/"><script>alert(1)</script>');
  assert.doesNotMatch(svg, /script|alert|x\.test/);
  assert.ok(qrSvg(L, {margin: -1, px: 0}).startsWith(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="360" height="360"'));
});

test("repeat calls give the same SVG and a fresh matrix (callers can't corrupt the cache)", () => {
  const first = qrSvg(L);
  assert.equal(qrSvg(L), first);
  const m = qrMatrix(L);
  m[0][0] = false;
  assert.equal(qrMatrix(L)[0][0], true);
  assert.equal(qrSvg(L), first);
});
