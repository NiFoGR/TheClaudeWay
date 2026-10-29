// QR codes for the review booster (pure). Encodes the text itself (the client's Google review URL, not a link on our
// host) so printed cards keep working forever. Vendored MIT encoder qrcode-generator 1.4.4, error correction M,
// version picked automatically, byte mode with UTF-8 bytes. The SVG has a white quiet zone of `margin` modules and one
// path with a unit square per dark module; no script, no text, nothing from the input except the encoded bits.

import qrcode from "../vendor/qrcode.js";

function toUtf8Bytes(s) {
  return Array.from(new TextEncoder().encode(s));
}

// The library's default turns each character into one byte (wrong for anything non-ASCII); use UTF-8. Set once here:
// this module is the vendored encoder's only user.
qrcode.stringToBytes = toUtf8Bytes;

// Encoding costs a few ms of CPU (8 mask trials); the review card prints the same code 8 times and the Site page shows
// it again, so finished results are kept per isolate (small, bounded; strings are immutable, matrices are copied).
const CACHE_MAX = 16;
const matrixCache = new Map();
const svgCache = new Map();

function remember(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function encode(value) {
  const hit = matrixCache.get(value);
  if (hit) return hit;
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  try {
    qr.make();
  } catch {
    throw new Error("That link is too long to fit in a QR code.");
  }
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c) === true);
    rows.push(row);
  }
  return remember(matrixCache, value, rows);
}

function textOf(text) {
  const value = String(text ?? "");
  if (!value) throw new Error("There's nothing to put in the QR code: the link is empty.");
  return value;
}

export function qrMatrix(text) {
  return encode(textOf(text)).map((row) => row.slice());
}

function wholeNumber(value, fallback, min) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function qrSvg(text, {margin = 4, px = 8} = {}) {
  const value = textOf(text);
  const quiet = wholeNumber(margin, 4, 0);
  const scale = wholeNumber(px, 8, 1);
  const key = `${quiet} ${scale} ${value}`;
  const hit = svgCache.get(key);
  if (hit) return hit;
  const m = encode(value);
  const size = m.length + quiet * 2;
  let d = "";
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return remember(svgCache, key, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" ` +
    `height="${size * scale}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`);
}
