// GoldBar Control Room: navigation and routing. Each page lives in its own file next to this one.
import { homePage } from "./home.js";
import { closeDrawer, leadsPage } from "./leads.js";
import { api, esc, icon, pageHead, state, view } from "./lib.js";
import { mapRankRoute } from "./maprank.js";
import { moneyPage } from "./money.js";
import { scraperRoute } from "./scraper.js";

const NAV = [
  [null, [["home", "Home", "home"]]],
  ["Find", [["scraper", "Lead Scraper", "search"], ["maprank", "Map Rank", "map"]]],
  ["Sell", [["leads", "Leads", "users"], [null, "Demos", "layout"], [null, "Outreach", "send"]]],
  ["Business", [["money", "Money", "pound"], [null, "Onboarding", "briefcase"]]],
];

const link = (route, label, ic) => route
  ? `<a href="#/${route}" data-route="${route}">${icon(ic)}<span class="lbl">${label}</span></a>`
  : `<span class="soon">${icon(ic)}${label}<small>soon</small></span>`;

document.getElementById("nav").innerHTML = NAV.map(([group, items]) =>
  `${group ? `<div class="nav-label">${group}</div>` : ""}${items.map(([r, l, i]) => link(r, l, i)).join("")}`).join("");
document.getElementById("nav-bottom").innerHTML = `${link("setup", "Setup", "sliders")}<a href="/logout">${icon("logout")}<span class="lbl">Log out</span></a>`;

async function setupPage() {
  view.innerHTML = pageHead("Setup", "Checking what's connected…");
  const { checks, note } = await api("/api/setup");
  const allOk = checks.every((c) => c.ok);
  view.innerHTML = `
    ${pageHead("Setup", allOk ? "Everything is connected. You're ready to find leads." : "Fix anything marked red, then refresh this page.")}
    <div class="card checks">${checks.map((c) => `
      <div class="check"><span class="dot ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✕"}</span>
        <div><b>${esc(c.name)}</b><div class="muted small">${esc(c.ok ? c.detail : c.fix)}</div></div></div>`).join("")}
    </div>
    <p class="hint">${esc(note)} Full step-by-step guide: <code>control-room/README.md</code> in the repo.</p>`;
}

function currentPage() {
  const path = location.hash.split("?")[0].replace("#/", "");
  return ["home", "scraper", "maprank", "leads", "money", "setup"].includes(path) ? path : "home";
}

async function route() {
  const page = currentPage();
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === page));
  closeDrawer();
  if (state.map) { state.map.remove(); state.map = null; }
  window.scrollTo(0, 0);
  try {
    if (page === "setup") await setupPage();
    else if (page === "maprank") await mapRankRoute(params);
    else if (page === "leads") await leadsPage();
    else if (page === "money") await moneyPage();
    else if (page === "scraper") {
      if (params.get("job")) state.jobId = params.get("job");
      await scraperRoute();
    } else await homePage();
  } catch (err) {
    view.innerHTML = `${pageHead("Something's not set up")}<p class="error">${esc(err.message)}</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`;
  }
}

window.addEventListener("hashchange", route);
route();
