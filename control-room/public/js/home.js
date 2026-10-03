// Home: the important numbers and who to contact next, on one screen.
import { openDrawer } from "./leads.js";
import { api, esc, icon, kpi, money, pageHead, ring, view } from "./lib.js";
import { runRow } from "./scraper.js";

export async function homePage() {
  const data = await api("/api/overview");
  const { counts: c, next, jobs, money: m } = data;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const n = (v) => Number(v || 0).toLocaleString("en-GB");
  const funnel = [
    ["To contact", c.fresh, `${n(c.fresh_email)} with email`, "#/leads"],
    ["Contacted", c.contacted, "waiting on a reply", "#/leads"],
    ["Replied", c.replied, "follow these up", "#/leads"],
    ["Calls booked", c.call_booked, m.pipeline.value ? `${money(m.pipeline.value, { compact: true })} if they close` : "", "#/leads"],
    ["Won", c.won, "", "#/money", "won"],
  ].map(([label, v, sub, href, cls]) => `<a href="${href}" class="${cls || ""}"><span>${label}</span><b>${n(v)}</b><small>${sub}</small></a>`).join("");

  view.innerHTML = `
    ${pageHead(`${hello}, Nikiforos`, new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
      `<a class="btn" href="#/scraper">${icon("search")} Find leads</a>`)}
    <div class="kpis">
      ${kpi("Profit this month", money(m.thisMonth.profit), `${money(m.thisMonth.in)} in · ${money(m.thisMonth.out)} out`, "accent")}
      ${kpi("Monthly recurring", `${money(m.mrr)}<span class="faint" style="font-size:14px;font-weight:500">/mo</span>`, m.mrrSoon ? `+${money(m.mrrSoon)} when free periods end` : `goal ${money(m.goal)}/mo`)}
      ${kpi("Clients", m.activeClients, m.totalClients ? `${m.totalClients} all time` : "the first one's the hardest")}
      ${kpi("Leads", n(c.total), "worth pitching, all searches")}
    </div>
    <div class="section-title"><h2>Pipeline</h2><a class="small" href="#/leads">All leads</a></div>
    <div class="funnel">${funnel}</div>
    <div class="grid-main" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h2>Contact these next</h2><div class="muted small">Highest scores you haven't contacted yet</div></div><a class="small" href="#/leads">See all</a></div>
        ${next.length ? `<div class="next-list">${next.map((l, i) => `
          <div class="next" data-i="${i}">${ring(l.quality_score)}
            <div style="min-width:0"><div class="biz">${esc(l.name)}</div><div class="sub-line">${esc(l.issues[0] || "")}</div></div>
            <div class="contact-icons">
              <a class="icon-btn ${l.phone ? "" : "off"}" href="${l.phone ? `tel:${esc(l.phone.replace(/\s/g, ""))}` : "#"}" title="${esc(l.phone || "No phone")}" aria-label="Call">${icon("phone")}</a>
              <a class="icon-btn ${l.email ? "" : "off"}" href="${l.email ? `mailto:${esc(l.email)}` : "#"}" title="${esc(l.email || "No email")}" aria-label="Email">${icon("mail")}</a>
            </div></div>`).join("")}</div>`
          : `<p class="muted" style="margin:0">Nobody waiting. <a href="#/scraper">Find some leads</a>.</p>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Latest searches</h2><a class="small" href="#/scraper">Lead Scraper</a></div>
        ${jobs.length ? `<div class="runs">${jobs.map(runRow).join("")}</div>` : `<p class="muted" style="margin:0">No searches yet.</p>`}
      </div>
    </div>`;

  view.querySelectorAll(".next").forEach((el) => el.onclick = (e) => {
    if (e.target.closest("a")) return;
    openDrawer(next[Number(el.dataset.i)], () => homePage());
  });
  view.querySelectorAll(".run").forEach((r) => r.onclick = () => { location.hash = `#/scraper?job=${encodeURIComponent(r.dataset.id)}`; });
}
