// The KPIs page (#/kpis, optional ?week=2026-W43; stage 11, docs/rebuild/11-todo-kpis.md Part A "KPIs page"): one
// GET /api/kpis?week= and the HTML from kpisview.js (pure, tested in tests/kpisview.test.mjs). With no week the server
// picks the latest week with Claude's review, else the current UK week. The ‹ › arrows are plain links to
// /#/kpis?week=…, so the router opens the page again for that week. A bad or future week gets the server's 400 words
// ("Week should look like 2026-W43." / "That week hasn't started yet.") and a link back to the latest week.
import { api, esc, pageHead, view } from "./lib.js";
import { kpisHtml } from "./kpisview.js";

const SUB = "How your first emails and Claude's replies are doing, week by week.";

let visit = 0; // the newest kpisPage(): a slow answer never replaces a newer page

// URLSearchParams from the router, or anything with get(); else the hash's own ?week=.
function weekFrom(params) {
  const fromParams = typeof params?.get === "function" ? params.get("week") : null;
  if (fromParams) return fromParams.trim();
  const q = location.hash.split("?")[1] || "";
  return (new URLSearchParams(q).get("week") || "").trim();
}

// An error's words, plain: the server's sentence as it is, or what went wrong with the connection.
function reason(err) {
  if (err instanceof TypeError) return "The Control Room didn't answer (check your internet connection). Refresh the page.";
  const text = String(err?.message ?? err ?? "").trim();
  // lib.js's api() says only "Request failed (500)" when the server sent no words of its own.
  if (!text || /^Request failed \(\d+\)$/.test(text)) {
    return "The week's numbers didn't load. Refresh the page; if it keeps happening, check the lights on Setup.";
  }
  return text;
}

/** The KPIs page for `params.get("week")` (or the server's default week). */
export async function kpisPage(params) {
  const mine = ++visit;
  const week = weekFrom(params);
  view.innerHTML = `${pageHead("KPIs", SUB)}<div id="kpis-body"><p class="muted">Loading the week's numbers…</p></div>`;
  const el = document.getElementById("kpis-body");
  // Still this visit and still on the page: another page (or another week) replaces #kpis-body, so it's gone.
  const current = () => mine === visit && el.isConnected;
  let payload;
  try {
    payload = await api(`/api/kpis${week ? `?week=${encodeURIComponent(week)}` : ""}`);
  } catch (err) {
    if (!current()) return; // Nik moved on while it loaded
    // A week in the link was refused (bad or future): offer the default week. Without one, the link would go nowhere.
    const back = week ? `<p class="hint"><a class="btn secondary sm" href="/#/kpis">Open the latest week</a></p>` : "";
    el.innerHTML = `<p class="error">${esc(reason(err))}</p>${back}`;
    return;
  }
  if (!current()) return;
  el.innerHTML = kpisHtml(payload);
}
