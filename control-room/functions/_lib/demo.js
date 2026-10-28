// What's left of the old demo module. The order page moved to _lib/order-page.js (stage 9; its routes run
// _lib/checkout.js) and the demo page is drawn by the template engine in _lib/demo/ (GET /d/:slug, d/[slug]/index.js).
// Kept: isWeekendUK, the old ended page, and shortName/slugFor re-exported from demo/text.js.
// Pure (HTML strings), tested in control-room/tests/demo.test.mjs. Everything shown is escaped.

import { shortName, slugFor } from "./demo/text.js";

// shortName and slugFor live in demo/text.js now; re-exported here.
export { shortName, slugFor };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Saturday or Sunday in the UK (the weekend deal). */
export const isWeekendUK = (d = new Date()) => ["Sat", "Sun"].includes(new Date(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/London" }));

const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;background:#fff}
a{color:inherit}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ae-bar{position:sticky;top:0;z-index:10;background:#1A1C20;color:#fff;font-size:14px}
.ae-bar .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;flex-wrap:wrap}
.ae-bar b{color:#E2C26A}.ae-btn{background:#C9A13B;color:#1A1C20;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:8px;white-space:nowrap}
.ae-btn:hover{background:#E2C26A}
@media(max-width:600px){.ae-bar .wrap{flex-wrap:nowrap;padding:8px 14px}.ae-bar span{font-size:12.5px;line-height:1.35}.ae-btn{padding:8px 12px;font-size:13px}}
`;

/** The old ended page (the order page and the demo page use render.js's renderExpired): no dead link, a way back in. */
export function renderExpired(lead) {
  const name = shortName(lead?.name || "");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Preview ended</title><style>${BASE_CSS}body{background:#1A1C20;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center}
.box{max-width:520px;padding:24px}h1{font-size:28px}</style></head><body><div class="box"><h1>This preview has ended</h1>
<p>The website we built${name ? ` for ${esc(name)}` : ""} is no longer on show. Reply to our email if you'd like it back: we keep it for a little while.</p>
<p style="color:#E2C26A">Aetos Websites</p></div></body></html>`;
}
