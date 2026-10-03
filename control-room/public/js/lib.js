// Shared helpers. Every value from scraped websites goes through esc()/safeUrl() before it touches the page.

export const view = document.getElementById("view");

export const state = {
  jobs: [], jobId: null, leads: [], filter: "pitch", search: "", poll: null, showScoreHelp: false, showAllRuns: false,
  scans: [], scanId: null, scan: null, biz: null, scanPoll: null, map: null, showAllScans: false,
  drawer: null, money: null,
};

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

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

const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  pound: '<path d="M18 7c0-5.333-8-5.333-8 0"/><path d="M10 7v14"/><path d="M6 21h12"/><path d="M6 13h10"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
};

export const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

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
