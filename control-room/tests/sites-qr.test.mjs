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

// An independent reader (ISO/IEC 18004 layout, written from the standard, not from the vendored code) so the test proves
// the symbol a phone would scan really holds the review link at ECC M, without a phone. Version 5 only (no version
// info, one alignment pattern at (30,30)); v5-M is 2 blocks of 43 data + 24 error-correction codewords.
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function formatBits(m) {
  const n = m.length;
  const bit = (r, c) => (m[r][c] ? 1 : 0);
  const first = [], second = []; // MSB (bit 14) first
  for (const c of [0, 1, 2, 3, 4, 5, 7, 8]) first.push(bit(8, c));
  for (const r of [7, 5, 4, 3, 2, 1, 0]) first.push(bit(r, 8));
  for (let r = n - 1; r >= n - 7; r--) second.push(bit(r, 8));
  for (let c = n - 8; c <= n - 1; c++) second.push(bit(8, c));
  const value = (bits) => bits.reduce((v, b) => (v << 1) | b, 0) ^ 0b101010000010010;
  return { first: value(first), second: value(second), dark: m[n - 8][8] };
}

function bchValid(format) {
  let rem = format;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);
  return rem === 0;
}

function isFunctionV5(r, c, n) {
  if (r <= 8 && c <= 8) return true; // top-left finder, separator, format
  if (r <= 8 && c >= n - 8) return true; // top-right
  if (r >= n - 8 && c <= 8) return true; // bottom-left (and the dark module)
  if (r === 6 || c === 6) return true; // timing
  return Math.abs(r - 30) <= 2 && Math.abs(c - 30) <= 2; // alignment
}

function readCodewords(m, mask) {
  const n = m.length;
  const bits = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (isFunctionV5(r, c, n)) continue;
        bits.push((m[r][c] ? 1 : 0) ^ (MASKS[mask](r, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  return { words, bitCount: bits.length };
}

function rsRemainder(data, ecLen) {
  const exp = new Array(512), log = new Array(256);
  for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) { exp[i] = x; log[x] = i; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((g, k) => { next[k] ^= g; next[k + 1] ^= mul(g, exp[i]); });
    gen = next;
  }
  const rem = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const f = rem[i];
    if (f) gen.forEach((g, k) => { rem[i + k] ^= mul(g, f); });
  }
  return rem.slice(data.length);
}

test("an independent reader decodes qrMatrix(L): ECC M, byte mode, exactly the review link, valid Reed-Solomon", () => {
  const m = qrMatrix(L);
  const { first, second, dark } = formatBits(m);
  assert.equal(first, second, "both format-info copies agree");
  assert.ok(bchValid(first), "format info has a valid BCH code");
  assert.equal(dark, true, "the dark module is set");
  assert.equal(first >> 13, 0b00, "error correction level M");
  const { words, bitCount } = readCodewords(m, (first >> 10) & 7);
  assert.equal(bitCount, 134 * 8 + 7); // 134 codewords + 7 remainder bits in version 5
  const blocks = [0, 1].map((b) => ({
    data: Array.from({ length: 43 }, (_, k) => words[2 * k + b]),
    ec: Array.from({ length: 24 }, (_, k) => words[86 + 2 * k + b]),
  }));
  for (const block of blocks) assert.deepEqual(rsRemainder(block.data, 24), block.ec);
  const stream = blocks.flatMap((block) => block.data).map((w) => w.toString(2).padStart(8, "0")).join("");
  assert.equal(stream.slice(0, 4), "0100", "byte mode");
  const count = parseInt(stream.slice(4, 12), 2);
  assert.equal(count, 79);
  const bytes = Array.from({ length: count }, (_, k) => parseInt(stream.slice(12 + 8 * k, 20 + 8 * k), 2));
  assert.equal(new TextDecoder().decode(new Uint8Array(bytes)), L);
  assert.equal(stream.slice(12 + 8 * count, 16 + 8 * count), "0000", "terminator");
});

test("the SVG draws exactly the matrix: every dark module and nothing else", () => {
  const m = qrMatrix(L);
  const svg = qrSvg(L);
  const d = svg.match(/<path[^>]* d="([^"]*)"/)[1];
  assert.match(d, /^(M\d+ \d+h1v1h-1z)+$/);
  const drawn = new Set([...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => `${y - 4},${x - 4}`));
  const want = new Set();
  m.forEach((row, r) => row.forEach((on, c) => { if (on) want.add(`${r},${c}`); }));
  assert.deepEqual(drawn, want);
});
