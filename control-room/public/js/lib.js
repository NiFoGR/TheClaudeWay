// Shared helpers. Every value from scraped websites goes through esc()/safeUrl() before it touches the page.
// esc, safeUrl and icon live in html.js (pure, so node tests and pure renderers import them without a page); they're
// re-exported here so every page keeps importing them from ./lib.js. The import is for this file's own use.
import { esc } from "./html.js";

export { esc, icon, safeUrl } from "./html.js";

export const view = document.getElementById("view");

export const state = {
  jobs: [], jobId: null, leads: [], filter: "pitch", search: "", poll: null, showScoreHelp: false, showAllRuns: false,
  scans: [], scanId: null, scan: null, biz: null, scanPoll: null, map: null, showAllScans: false,
  drawer: null, money: null, selected: new Set(),
};

export async function api(path, options = {}) {
  const resp = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (resp.status === 401) location.href = "/login";
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && !data.job && !data.scan) {
    const err = new Error(data.error || `Request failed (${resp.status})`);
    err.issues = data.issues || [];
    throw err;
  }
  return data;
}

// The prices (functions/_lib/offer.js, served by GET /api/offer), fetched once per page load and shared. The Money
// page doesn't use it: it reads the same packages from /api/money's summary.packages.
let offerPromise = null;
export function getOffer() {
  offerPromise ||= api("/api/offer").catch((err) => {
    offerPromise = null; // a failed fetch is tried again next time
    throw err;
  });
  return offerPromise;
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export const today = () => new Date().toISOString().slice(0, 10);

export function fmtDate(iso, withYear = false) {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
}

export function monthName(key, long = false) {
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: long ? "long" : "short", year: long ? "numeric" : undefined, timeZone: "UTC" });
}

/** pence → "£1,950" (pennies only when there are some, or always with exact). compact → "£1.9k". */
export function money(pence, { compact = false, sign = false, exact = false } = {}) {
  const p = Number(pence) || 0;
  const pounds = Math.abs(p) / 100;
  let s;
  if (compact && pounds >= 1000) s = `£${(pounds / 1000).toFixed(pounds >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  else {
    const pennies = exact || (pounds < 1000 && p % 100 !== 0);
    s = `£${pounds.toLocaleString("en-GB", { minimumFractionDigits: pennies ? 2 : 0, maximumFractionDigits: pennies ? 2 : 0 })}`;
  }
  if (p < 0) return `−${s}`;
  return sign && p > 0 ? `+${s}` : s;
}

export const scoreClass = (n) => (n >= 70 ? "hi" : n >= 35 ? "mid" : "lo");

export function ring(score, big = false) {
  if (score === null || score === undefined) return `<span class="ring${big ? " lg" : ""}"><b>–</b></span>`;
  return `<span class="ring ${scoreClass(score)}${big ? " lg" : ""}" style="--p:${Number(score) || 0}" title="Score ${esc(score)}/100: how much we can help them"><b>${esc(score)}</b></span>`;
}

export function pageHead(title, sub, actions = "") {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
}

export function kpi(label, value, sub = "", cls = "") {
  return `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
}

export function toast(message) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

/** Open a <dialog> with the given inner HTML; returns the element. Closes on Esc, the × and the backdrop. */
export function modal(html) {
  const d = document.createElement("dialog");
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => d.close());
  d.showModal();
  return d;
}

/** A short burst of gold confetti, for wins. */
export function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext("2d");
  const colors = ["#C9A13B", "#E2C26A", "#9C7A25", "#FFFFFF", "#45c381"];
  const bits = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight / 3, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 14 - 4,
    r: Math.random() * 6 + 3, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * Math.PI,
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.vy += 0.45; b.vx *= 0.99; b.a += 0.2;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.c; ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore();
    }
    if (++frame < 120) requestAnimationFrame(tick);
    else c.remove();
  })();
}
