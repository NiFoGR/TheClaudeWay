// Aetos Control Room: navigation and routing. Each page lives in its own file next to this one.
import { homePage } from "./home.js";
import { closeDrawer, leadsPage } from "./leads.js";
import { api, esc, icon, pageHead, state, toast, view } from "./lib.js";
import { mapRankRoute } from "./maprank.js";
import { outreachPage } from "./outreach.js";
import { roadmapPage } from "./roadmap.js";
import { bindCopy, moneyPage, paymentLinks } from "./money.js";
import { scraperRoute } from "./scraper.js";

const NAV = [
  [null, [["home", "Home", "home"]]],
  ["Find", [["scraper", "Lead Scraper", "search"], ["maprank", "Map Rank", "map"]]],
  ["Sell", [["leads", "Leads", "users"], [null, "Demos", "layout"], ["outreach", "Outreach", "send"], [null, "Replies", "mail"]]],
  ["Business", [["money", "Money", "pound"], [null, "Onboarding", "briefcase"], [null, "Monthly care", "spark"], [null, "Website", "globe"]]],
];

const link = (route, label, ic) => route
  ? `<a href="#/${route}" data-route="${route}">${icon(ic)}<span class="lbl">${label}</span></a>`
  : `<a href="#/roadmap" class="soon" title="Coming soon: see the Roadmap">${icon(ic)}${label}<small>soon</small></a>`;

document.getElementById("nav").innerHTML = NAV.map(([group, items]) =>
  `${group ? `<div class="nav-label">${group}</div>` : ""}${items.map(([r, l, i]) => link(r, l, i)).join("")}`).join("");
document.getElementById("nav-bottom").innerHTML = `${link("roadmap", "Roadmap", "check")}${link("setup", "Setup", "sliders")}<a href="/logout">${icon("logout")}<span class="lbl">Log out</span></a>`;

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
    <p class="hint">${esc(note)} Full step-by-step guide: <code>control-room/README.md</code> in the repo.</p>
    <div id="stripe-card"></div>`;
  await stripeCard();
}

async function stripeCard() {
  const el = view.querySelector("#stripe-card");
  const s = await api("/api/stripe/setup");
  const mode = s.mode === "live" ? `<span class="badge good">Live: real payments</span>` : `<span class="badge warn">Test mode: no real money</span>`;
  if (s.ready) {
    el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Stripe payment links</h2>${mode}</div>
      <p class="muted" style="margin-top:0">Send one after the call. When they pay, they appear on the Money page as a client by themselves.</p>
      ${paymentLinks(s.links)}
      ${s.mode === "test" ? `<p class="hint">Try one now with card <code>4242 4242 4242 4242</code>, any future date, any CVC. Happy? Replace <code>STRIPE_SECRET_KEY</code> in Cloudflare with your live key (<code>sk_live_…</code>), retry the deployment, and press Set up Stripe again for real links.</p>` : ""}
      <p class="hint">In Stripe → Settings → Billing → Subscriptions and emails: turn on <b>Send reminders before trials end</b> and <b>Smart Retries</b>. That's the day-61 reminder and failed-payment chasing, done by Stripe.</p></div>`;
    bindCopy(el);
    return;
  }
  el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Connect Stripe</h2>${s.hasKey ? mode : ""}</div>
    <ol class="steps">
      <li><b>Stripe</b> → Developers → API keys → copy the <b>Secret key</b> (starts <code>sk_test_</code> to try it first, <code>sk_live_</code> for real money).</li>
      <li><b>Cloudflare</b> → your Pages project → Settings → Variables and Secrets → Add: name <code>STRIPE_SECRET_KEY</code>, type <b>Secret</b>, paste the key.</li>
      <li>Deployments → <b>Retry deployment</b> so the key takes effect, then come back here.</li>
      <li>Press <b>Set up Stripe</b>: it creates your three packages, a payment link for each, and connects payments to the Money page.</li>
    </ol>
    <p style="margin-bottom:0"><button class="btn" id="stripe-go" ${s.hasKey ? "" : "disabled"}>Set up Stripe</button>
      ${s.hasKey ? "" : `<span class="hint" style="margin-left:8px">Waiting for the key (steps 1–3).</span>`}</p>
    <p class="error" id="stripe-error" hidden></p></div>`;
  const go = el.querySelector("#stripe-go");
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "Setting up…";
    try {
      await api("/api/stripe/setup", { method: "POST" });
      toast("Stripe is set up.");
      await setupPage();
    } catch (e) {
      el.querySelector("#stripe-error").textContent = e.message;
      el.querySelector("#stripe-error").hidden = false;
      go.disabled = false;
      go.textContent = "Set up Stripe";
    }
  };
}

function currentPage() {
  const path = location.hash.split("?")[0].replace("#/", "");
  return ["home", "scraper", "maprank", "leads", "outreach", "money", "setup", "roadmap"].includes(path) ? path : "home";
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
    else if (page === "outreach") await outreachPage();
    else if (page === "roadmap") roadmapPage();
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
