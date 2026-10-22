// Aetos Control Room: navigation and routing. Each page lives in its own file next to this one, and PAGES lists them.
import { homePage } from "./home.js";
import { closeDrawer, leadsPage } from "./leads.js";
import { api, esc, icon, pageHead, state, view } from "./lib.js";
import { mapRankRoute } from "./maprank.js";
import { moneyPage } from "./money.js";
import { scraperRoute } from "./scraper.js";
import { setupPage } from "./setup.js";

// Every page: {route, label, icon, render(params), nav?}. The nav shows the pages in this order; `nav: false` is
// routable but not in the nav, and `nav: "bottom"` sits at the bottom, above Log out. Only built pages are listed.
// Later stages add their entries here, until file 11 replaces this with public/js/nav.js.
export const PAGES = [
  { route: "home", label: "Home", icon: "home", render: () => homePage() },
  { route: "leads", label: "Leads", icon: "users", render: () => leadsPage() },
  {
    route: "scraper", label: "Lead Scraper", icon: "search",
    render: (params) => {
      if (params.get("job")) state.jobId = params.get("job");
      return scraperRoute();
    },
  },
  { route: "maprank", label: "Map Rank", icon: "map", render: (params) => mapRankRoute(params) },
  { route: "money", label: "Money", icon: "pound", render: () => moneyPage() },
  { route: "setup", label: "Setup", icon: "sliders", render: (params) => setupPage(params), nav: "bottom" },
];

const place = (p) => (p.nav === false ? null : p.nav === "bottom" ? "bottom" : "main");
const navLink = (p) => `<a href="#/${esc(p.route)}" data-route="${esc(p.route)}">${icon(p.icon)}<span class="lbl">${esc(p.label)}</span></a>`;
const navFor = (where) => PAGES.filter((p) => place(p) === where).map(navLink).join("");

document.getElementById("nav").innerHTML = navFor("main");
document.getElementById("nav-bottom").innerHTML = `${navFor("bottom")}<a href="/logout">${icon("logout")}<span class="lbl">Log out</span></a>`;

/** The page named by the hash's first segment ("#/scraper?job=1" → scraper) and its query. Unknown pages → home. */
function currentPage() {
  const hash = location.hash.replace(/^#\/?/, "");
  const q = hash.indexOf("?");
  const name = (q < 0 ? hash : hash.slice(0, q)).split("/")[0];
  const page = PAGES.find((p) => p.route === name) || PAGES.find((p) => p.route === "home");
  return { page, params: new URLSearchParams(q < 0 ? "" : hash.slice(q + 1)) };
}

async function route() {
  const { page, params } = currentPage();
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === page.route));
  closeDrawer();
  if (state.map) { state.map.remove(); state.map = null; }
  window.scrollTo(0, 0);
  try {
    await page.render(params);
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
