// Aetos Control Room: navigation and routing. Each page lives in its own file next to this one, and PAGES lists them.
import { callIdFrom, callPage } from "./call.js";
import { demoPage } from "./demo.js";
import { homePage } from "./home.js";
import { closeDrawer, leadsPage, openLeadDrawer } from "./leads.js";
import { parseRoute } from "./leadview.js";
import { api, esc, icon, pageHead, state, view } from "./lib.js";
import { mapRankRoute } from "./maprank.js";
import { moneyPage } from "./money.js";
import { repliesPage, threadIdFrom, threadPage } from "./replies.js";
import { scraperRoute } from "./scraper.js";
import { setupPage } from "./setup.js";
import { voicePage } from "./voice.js";

// Every page: {route, label, icon, render(params), nav?}. The nav shows the pages in this order; `nav: false` is
// routable but not in the nav, and `nav: "bottom"` sits at the bottom, above Log out. Only built pages are listed.
// Later stages add their entries here, until file 11 replaces this with public/js/nav.js.
export const PAGES = [
  { route: "home", label: "Home", icon: "home", render: () => homePage() },
  { route: "leads", label: "Leads", icon: "users", render: (params) => leadsPage(params) },
  {
    route: "scraper", label: "Lead Scraper", icon: "search",
    render: (params) => {
      if (params.get("job")) state.jobId = params.get("job");
      return scraperRoute();
    },
  },
  { route: "maprank", label: "Map Rank", icon: "map", render: (params) => mapRankRoute(params) },
  { route: "money", label: "Money", icon: "pound", render: () => moneyPage() },
  // Stage 5–6: the 9 follow-up emails to approve, and Nik's own replies and rules for Claude.
  { route: "voice", label: "Voice", icon: "mail", render: () => voicePage() },
  // Stage 7: every reply, what needs Nik, and the pause switch; #/replies/<place_id> is one conversation.
  { route: "replies", label: "Replies", icon: "send", render: () => { const id = threadIdFrom(location.hash); return id ? threadPage(id) : repliesPage(); } },
  // Stage 4: reached from the "Approve the … look" todo and the lead panel's "Demo page" link, not the nav.
  { route: "demo", label: "Demo", icon: "layout", render: () => demoPage(), nav: false },
  // Stage 8: one call (#/call/<id>), linked from every call Todo; the script, Cancel call, and How did it go?
  { route: "call", nav: false, label: "Call", icon: "phone", render: () => callPage(callIdFrom(location.hash)) },
  { route: "setup", label: "Setup", icon: "sliders", render: (params) => setupPage(params), nav: "bottom" },
];

const place = (p) => (p.nav === false ? null : p.nav === "bottom" ? "bottom" : "main");
const navLink = (p) => `<a href="#/${esc(p.route)}" data-route="${esc(p.route)}">${icon(p.icon)}<span class="lbl">${esc(p.label)}</span></a>`;
const navFor = (where) => PAGES.filter((p) => place(p) === where).map(navLink).join("");

document.getElementById("nav").innerHTML = navFor("main");
document.getElementById("nav-bottom").innerHTML = `${navFor("bottom")}<a href="/logout">${icon("logout")}<span class="lbl">Log out</span></a>`;

let turn = 0; // the newest route: a slow page never opens its lead panel over the next one

// The page named by the hash's first segment (parseRoute: "#/scraper?job=1" → scraper, "#/lead/<place_id>" → leads
// with that lead's panel), found in PAGES; an unknown page → home, so a stage only adds its PAGES entry.
async function route() {
  const { page: name, params, leadId } = parseRoute(location.hash);
  const page = PAGES.find((p) => p.route === name) || PAGES.find((p) => p.route === "home");
  const mine = ++turn;
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === page.route));
  closeDrawer();
  if (state.map) { state.map.remove(); state.map = null; }
  window.scrollTo(0, 0);
  try {
    await page.render(params);
    // #/lead/<place_id>: the Leads page first, then its panel (closeDrawer above has already run).
    if (leadId && page.route === "leads" && mine === turn) openLeadDrawer(leadId);
  } catch (err) {
    view.innerHTML = `${pageHead("Something's not set up")}<p class="error">${esc(err.message)}</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`;
  }
}

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
