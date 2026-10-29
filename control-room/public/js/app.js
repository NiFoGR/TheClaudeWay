// Aetos Control Room: the nav and routing. Each page lives in its own file next to this one; nav.js holds the nav
// (NAV) and the one route list (routeFor), and this file draws the one and dispatches on the other.
import { callPage } from "./call.js";
import { demoPage } from "./demo.js";
import { kpisPage } from "./kpis.js";
import { closeDrawer, leadsPage, openLeadDrawer } from "./leads.js";
import { api, esc, icon, pageHead, state, view } from "./lib.js";
import { mapRankRoute } from "./maprank.js";
import { moneyPage } from "./money.js";
import { NAV, activeNav, badgeHtml, badgeLabel, badgeState, routeFor } from "./nav.js";
import { repliesPage, threadPage } from "./replies.js";
import { scraperRoute } from "./scraper.js";
import { setupPage } from "./setup.js";
import { sitePage, sitesPage } from "./sites.js";
import { stopTodoPoll, todoPage } from "./todo.js";
import { voicePage } from "./voice.js";

// The flat nav in NAV's order, Log out under it. Todo carries the badge: the gold count of overdue + today's items,
// and a red dot when any light is red (hidden at 0 and 0).
const navLink = ([route, label, name]) => `<a href="#/${esc(route)}" data-route="${esc(route)}">${icon(name)}<span class="lbl">${esc(label)}</span>${
  route === "todo" ? '<span id="todo-badge" class="nav-badge" hidden></span>' : ""}</a>`;
document.getElementById("nav").innerHTML = NAV.map(navLink).join("");
document.getElementById("nav-bottom").innerHTML = `<a href="/logout">${icon("logout")}<span class="lbl">Log out</span></a>`;

// What each page runs. `lead` is the Leads page with that lead's panel open on top.
const PAGE_RUN = {
  todo: () => todoPage(),
  leads: ({ params }) => leadsPage(params),
  lead: ({ params }) => leadsPage(params),
  scraper: ({ params }) => {
    if (params.get("job")) state.jobId = params.get("job");
    return scraperRoute();
  },
  maprank: ({ params }) => mapRankRoute(params),
  replies: ({ id }) => (id ? threadPage(id) : repliesPage()),
  call: ({ id }) => callPage(id),
  kpis: ({ params }) => kpisPage(params),
  money: () => moneyPage(),
  voice: () => voicePage(),
  setup: ({ params }) => setupPage(params),
  demo: () => demoPage(),
  // Stage 10's client sites: routed, not in the nav (linked from build todos, Setup and the client page).
  sites: () => sitesPage(),
  site: ({ id }) => sitePage(id),
};

let turn = 0; // the newest route: a slow page never opens its lead panel over the next one

async function route() {
  stopTodoPoll(); // Todo's 60 s refresh runs only while it's open; todoPage starts it again
  const { page, id, params } = routeFor(location.hash);
  const mine = ++turn;
  const lit = activeNav(page);
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === lit));
  closeDrawer();
  if (state.map) { state.map.remove(); state.map = null; }
  window.scrollTo(0, 0);
  try {
    await (PAGE_RUN[page] || PAGE_RUN.todo)({ id, params });
    // #/lead/<place_id>: the Leads page first, then its panel (closeDrawer above has already run).
    if (page === "lead" && id && mine === turn) openLeadDrawer(id);
  } catch (err) {
    view.innerHTML = `${pageHead("Something's not set up")}<p class="error">${esc(err.message)}</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`;
  }
  if (mine === turn) refreshBadge();
}

// ---------------------------------------------------------------- the Todo badge

let badgeAsk = 0; // the newest count: a slow answer never overwrites a newer one

function showBadge(counts) {
  const el = document.getElementById("todo-badge");
  if (!el) return;
  const s = badgeState(counts);
  el.innerHTML = badgeHtml(counts);
  el.hidden = s.hidden;
  el.classList.toggle("only-red", !s.due && s.red);
  if (s.hidden) el.removeAttribute("aria-label");
  else el.setAttribute("aria-label", badgeLabel(counts));
}

// After each route. A failed count leaves the badge hidden (a stale number could be wrong).
async function refreshBadge() {
  const ask = ++badgeAsk;
  let counts = null;
  try {
    counts = await api("/api/todo/count");
  } catch {
    counts = null;
  }
  if (ask === badgeAsk) showBadge(counts);
}

// The Todo page sends its own counts after each load and each Done/Dismiss/Send, so the badge needs no second fetch.
window.addEventListener("aetos:todo-counts", (e) => {
  badgeAsk++;
  showBadge(e.detail);
});

// ---------------------------------------------------------------- red banner (D-7): name and address missing

const BANNER = "Your name and business address aren't on aetoswebsites.com yet. The law needs them: add them on";
let banner = null;

function showBanner(complete) {
  if (complete) {
    banner?.remove();
    banner = null;
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "banner-red";
    banner.innerHTML = `${esc(BANNER)} <a href="#/setup?at=business">Setup → Business details</a>.`;
  }
  if (view.firstElementChild !== banner) view.prepend(banner);
}

// Pages redraw by replacing everything in the view, the banner included, so it's put back on top every time.
new MutationObserver(() => {
  if (banner && view.firstElementChild !== banner) view.prepend(banner);
}).observe(view, { childList: true });
window.addEventListener("aetos:business", (e) => showBanner(e.detail?.complete === true));
api("/api/setup/business").then((b) => showBanner(b.complete === true)).catch(() => {
  // No answer (e.g. the database isn't connected yet): Setup's Connections say what's wrong.
});

window.addEventListener("hashchange", route);
route();
