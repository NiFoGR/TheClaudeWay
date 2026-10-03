// Money page: profit, monthly recurring income, clients, costs (Google API tracked automatically), forecast.
import { api, confetti, esc, fmtDate, icon, kpi, modal, money, monthName, pageHead, state, toast, today, view } from "./lib.js";

const PACKAGES = {
  full: { label: "Full Package", build: 1950, monthly: 249, freeDays: 60, note: "£1,950 + £249/mo, first 60 days free" },
  weekend: { label: "Weekend deal", build: 1750, monthly: 249, freeDays: 90, note: "£1,750 + £249/mo, first 90 days free" },
  website: { label: "Website Only", build: 1750, monthly: 0, freeDays: 0, note: "£1,750 one-off, no monthly" },
};
const COST_CATEGORIES = ["Mailboxes", "Domains", "Tools & software", "Ads", "Other"];
const SERIES = { in: "var(--series-in)", out: "var(--series-out)", profit: "var(--series-profit)" };

// ---------------------------------------------------------------- page

export async function moneyPage(fresh = true) {
  if (fresh || !state.money) state.money = await api("/api/money");
  const { summary: s, entries } = state.money;
  const m = s.thisMonth;
  const vsLast = m.profit - s.lastMonthProfit;
  const freeClients = s.clients.filter((c) => c.key === "free").length;

  view.innerHTML = `
    ${pageHead("Money", `What's come in, what's gone out, and what's coming. ${esc(monthName(s.month, true))}.`,
      `<button class="btn secondary" id="add-cost">${icon("plus")} Add cost</button><button class="btn" id="add-client">${icon("plus")} Add client</button>`)}
    <div class="money-top">
      <div class="hero">
        <div class="hero-label">${icon("pound")} Profit this month</div>
        <div class="hero-value ${m.profit < 0 ? "neg" : ""}" id="hero-value" data-to="${m.profit}">${money(m.profit)}</div>
        <div class="hero-sub">
          <span>In <b class="amount-in">${money(m.in)}</b></span>
          <span>Out <b>${money(m.out)}</b></span>
          <span>${vsLast >= 0 ? `<b class="up">▲ ${money(vsLast)}</b>` : `<b class="down">▼ ${money(-vsLast)}</b>`} vs ${esc(monthName(s.months[4].month))}</span>
          ${m.expectedProfit !== m.profit ? `<span>Month end: <b>${money(m.expectedProfit)}</b> expected</span>` : ""}
        </div>
        ${s.upcoming.length ? `<div class="coming"><h4>Coming in</h4>${s.upcoming.map((u) =>
          `<div><span>${esc(fmtDate(u.date))} · ${esc(u.label)} <span class="faint">${esc(u.category === "Monthly retainers" ? "monthly" : u.category.toLowerCase())}</span></span><b>+${money(u.pence)}</b></div>`).join("")}</div>` : ""}
      </div>
      <div class="kpis">
        ${kpi("Monthly recurring", `${money(s.mrr)}<span class="faint" style="font-size:14px;font-weight:500">/mo</span>`, s.mrrSoon ? `+${money(s.mrrSoon)}/mo when free periods end` : "retainers being paid now")}
        ${kpi("Clients", s.activeClients, freeClients ? `${freeClients} in their free period` : s.totalClients ? `${s.totalClients} all time` : "add one when they pay")}
        ${kpi("Spent this month", money(m.out), m.google ? `Google ${money(m.google, { exact: m.google < 100 })}` : m.googleCalls ? "Google: within the free allowance" : "Google: nothing yet")}
        ${kpi("All-time profit", money(s.allTime.profit), `${money(s.allTime.in)} in · ${money(s.allTime.out)} out`)}
      </div>
    </div>
    ${goalCard(s)}
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h2>Cashflow</h2><div class="muted small">Last 5 months, this month, and the next 6 from what's already committed</div></div>
        <div class="legend"><span><i style="background:${SERIES.in}"></i>Money in</span><span><i style="background:${SERIES.out}"></i>Money out</span>
          <span><i class="line" style="background:${SERIES.profit}"></i>Profit</span><span><i class="hatch"></i>Forecast</span></div></div>
      <div class="chart" id="chart"></div>
      <p class="hint">Next 6 months: <b style="color:var(--text)">${money(s.forecastProfit, { sign: true })}</b> profit from current clients and monthly costs alone. Every new client adds to it.</p>
    </div>
    <div class="grid-main" style="margin-top:16px">
      ${clientsCard(s)}
      <div class="stack">${pipelineCard(s)}${costsCard(s, entries)}</div>
    </div>
    ${entriesCard(entries)}`;

  drawChart(view.querySelector("#chart"), s.months);
  countUp(view.querySelector("#hero-value"));
  bindMoney();
}

function goalCard(s) {
  const pct = Math.min(100, (100 * s.mrr) / s.goal);
  const soonPct = Math.min(100 - pct, (100 * s.mrrSoon) / s.goal);
  const gap = Math.max(0, s.goal - s.mrr - s.mrrSoon);
  const more = Math.ceil(gap / 24900);
  const milestones = [
    ["First client", s.totalClients >= 1],
    ["£1k a month", s.mrr >= 100000],
    ["10 clients", s.activeClients >= 10],
    ["£5k a month", s.mrr >= 500000],
    ["£10k a month", s.mrr >= 1000000],
    ["£50k banked", s.allTime.in >= 5000000],
  ].map(([t, got]) => `<span class="milestone ${got ? "got" : ""}">${icon(got ? "trophy" : "check")}${t}</span>`).join("");
  return `<div class="card" style="margin-top:16px">
    <div class="goal-line">
      <div><div class="muted small" style="font-weight:550">Goal: monthly recurring income</div>
        <div class="big">${money(s.mrr)} <span class="faint" style="font-size:15px;font-weight:500">of ${money(s.goal)} a month</span></div></div>
      <div class="actions" style="align-items:center"><span class="muted small">${gap ? `${more} more client${more === 1 ? "" : "s"} on £249/mo to hit it` : "Goal hit. Raise it."}</span>
        <button class="btn ghost sm" id="edit-goal">Change goal</button></div>
    </div>
    <div class="goal-bar" title="${Math.round(pct)}% paying now${soonPct ? `, ${Math.round(soonPct)}% more once free periods end` : ""}">
      <em style="width:${pct + soonPct}%"></em><i style="width:${pct}%"></i></div>
    <div class="milestones">${milestones}</div>
  </div>`;
}

function clientsCard(s) {
  const rows = s.clients.map((c) => {
    const status = {
      paying: () => `<span class="badge good">Paying</span>`,
      free: () => `<span class="badge gold">Free until ${esc(fmtDate(c.firstCharge))}</span>`,
      stopped: () => `<span class="badge bad">Stopped ${esc(fmtDate(c.cancelled_on))}</span>`,
      "one-off": () => `<span class="badge plain">One-off</span>`,
    }[c.key]();
    return `<tr>
      <td><div class="client-name">${esc(c.name)}</div><div class="sub-line">${esc(PACKAGES[c.package]?.label || c.package)} · paid ${esc(fmtDate(c.paid_on, true))}</div></td>
      <td class="r num">${money(c.build_fee_pence)}</td>
      <td class="r num">${c.monthly_pence ? `${money(c.monthly_pence)}<span class="faint">/mo</span>` : "–"}</td>
      <td>${status}</td>
      <td class="r" style="white-space:nowrap">${c.key === "paying" || c.key === "free" ? `<button class="btn ghost sm" data-stop-client="${esc(c.id)}">Stopped paying</button>` : ""}
        <button class="icon-btn" data-del-client="${esc(c.id)}" aria-label="Delete client" title="Delete (added by mistake)">${icon("trash")}</button></td>
    </tr>`;
  }).join("");
  return `<div class="table-card">
    <div class="card-head" style="padding:18px 20px 0"><h2>Clients</h2><span class="muted">${s.totalClients} total</span></div>
    ${s.clients.length ? `<div class="table-wrap"><table class="clients-table"><thead><tr><th>Client</th><th class="r">Build</th><th class="r">Monthly</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">No clients yet. When someone pays, press <b>Add client</b>.<br>Their monthly kicks in here by itself once the free period ends.</div>`}
  </div>`;
}

function pipelineCard(s) {
  const p = s.pipeline;
  return `<div class="card">
    <div class="card-head"><h2>Pipeline</h2><a href="#/leads" class="small">Open leads</a></div>
    <div class="kpis" style="grid-template-columns:1fr 1fr">
      <div><div class="kpi-label">Calls booked</div><div class="kpi-value">${p.callsBooked}</div></div>
      <div><div class="kpi-label">Replied</div><div class="kpi-value">${p.replied}</div></div>
    </div>
    <p class="hint" style="margin-top:12px">${p.callsBooked ? `If every booked call closes on the Full Package: <b style="color:var(--gold)">${money(p.value)}</b> now + ${money(p.monthlyValue)}/mo.` : "Mark leads as “call booked” to see what they're worth here."}</p>
  </div>`;
}

function costsCard(s, entries) {
  const cur = s.months.find((x) => x.current);
  const cats = Object.entries(cur.breakdown.out).sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...cats.map(([, v]) => v));
  const g = s.thisMonth;
  const leadSearches = g.googleSkus.text_search_enterprise || 0;
  return `<div class="card">
    <div class="card-head"><h2>Costs this month</h2><span class="muted num">${money(cur.out)}</span></div>
    ${cats.length ? `<div class="cost-rows">${cats.map(([k, v]) => `
      <div class="cost-row"><span>${esc(k)}</span><b class="num">${money(v, { exact: v > 0 && v < 100 })}</b><div class="bar"><i style="width:${(100 * v) / top}%"></i></div></div>`).join("")}</div>`
      : `<p class="muted" style="margin:0">Nothing yet this month.</p>`}
    <p class="hint">Google is tracked automatically: ${leadSearches.toLocaleString("en-GB")} of 1,000 free lead-search calls used this month (about 3 per 60 leads). Heatmap grid searches are free.</p>
  </div>`;
}

function entriesCard(entries) {
  const rows = entries.map((e) => `<tr>
    <td class="num" style="white-space:nowrap">${esc(fmtDate(e.on_date, true))}</td>
    <td><div class="client-name">${esc(e.label)}</div><div class="sub-line">${esc(e.category)}${e.monthly ? ` · every month${e.ended_on ? `, stopped ${esc(fmtDate(e.ended_on))}` : ""}` : ""}</div></td>
    <td class="r num ${e.kind === "in" ? "amount-in" : ""}">${e.kind === "in" ? "+" : "−"}${money(e.amount_pence, { exact: e.amount_pence % 100 !== 0 })}${e.monthly ? `<span class="faint">/mo</span>` : ""}</td>
    <td class="r" style="white-space:nowrap">${e.monthly && !e.ended_on ? `<button class="btn ghost sm" data-stop-entry="${esc(e.id)}">Stop</button>` : ""}
      <button class="icon-btn" data-del-entry="${esc(e.id)}" aria-label="Delete" title="Delete">${icon("trash")}</button></td></tr>`).join("");
  return `<div class="section-title"><h2>Costs and other money you've added</h2><button class="btn ghost sm" id="add-cost-2">${icon("plus")} Add</button></div>
    <div class="table-card">${entries.length ? `<div class="table-wrap"><table class="entries-table"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">Add your mailboxes, domains and tools here (tick “every month” for subscriptions).<br>Build fees and retainers come from <b>Clients</b>; Google costs track themselves.</div>`}</div>`;
}

// ---------------------------------------------------------------- chart (SVG, hover tooltip per month)

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

function drawChart(el, months) {
  if (!el) return;
  const W = Math.max(300, el.clientWidth);
  const H = W < 600 ? 240 : 300;
  const pad = { l: 56, r: 8, t: 22, b: 28 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const maxUp = Math.max(100000, ...months.map((m) => Math.max(m.in, m.profit)));
  const maxDown = Math.max(0, ...months.map((m) => Math.max(m.out, -m.profit)));
  const step = niceStep(maxUp + maxDown);
  const top = Math.ceil(maxUp / step) * step;
  // a full step below £0 only when costs need it; small costs get just enough room to show
  const bottom = maxDown > step / 3 ? -Math.ceil(maxDown / step) * step : -Math.max(maxDown * 1.4, step / 12);
  const y = (v) => pad.t + ((top - v) / (top - bottom)) * ph;
  const band = pw / months.length;
  const bw = Math.min(30, band * 0.46);
  const x = (i) => pad.l + band * i + band / 2;
  const r = (h) => Math.min(4, h); // rounded data-end, never taller than the bar

  const ticks = [];
  for (let v = Math.ceil(bottom / step) * step; v <= top + 1; v += step) ticks.push(v);
  const firstForecast = months.findIndex((m) => m.forecast);
  const bars = months.map((m, i) => {
    const cx = x(i) - bw / 2;
    const z = y(0);
    const hIn = z - y(m.in);
    const hOut = y(-m.out) - z;
    const f = m.forecast;
    const inBar = hIn > 0.5 ? `<path d="M${cx},${z - 1} v${-(hIn - 1 - r(hIn))} q0,${-r(hIn)} ${r(hIn)},${-r(hIn)} h${bw - 2 * r(hIn)} q${r(hIn)},0 ${r(hIn)},${r(hIn)} v${hIn - 1 - r(hIn)} z" fill="${f ? "url(#hatch-in)" : SERIES.in}" ${f ? `stroke="${SERIES.in}" stroke-width="1"` : ""}/>` : "";
    const outBar = hOut > 0.5 ? `<path d="M${cx},${z + 1} v${hOut - 1 - r(hOut)} q0,${r(hOut)} ${r(hOut)},${r(hOut)} h${bw - 2 * r(hOut)} q${r(hOut)},0 ${r(hOut)},${-r(hOut)} v${-(hOut - 1 - r(hOut))} z" fill="${f ? "url(#hatch-out)" : SERIES.out}" ${f ? `stroke="${SERIES.out}" stroke-width="1"` : ""}/>` : "";
    return inBar + outBar;
  }).join("");
  const pts = months.map((m, i) => [x(i), y(m.profit)]);
  const cur = months.findIndex((m) => m.current);
  const line = (a, b) => pts.slice(a, b + 1).map(([px, py], k) => `${k ? "L" : "M"}${px},${py}`).join("");
  const labelEvery = W < 520 ? 2 : 1;

  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Money in, money out and profit by month">
    <defs>
      <pattern id="hatch-in" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${SERIES.in}" fill-opacity="0.18"/><line x1="0" y1="0" x2="0" y2="5" stroke="${SERIES.in}" stroke-width="2"/></pattern>
      <pattern id="hatch-out" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="5" height="5" fill="${SERIES.out}" fill-opacity="0.18"/><line x1="0" y1="0" x2="0" y2="5" stroke="${SERIES.out}" stroke-width="2"/></pattern>
    </defs>
    ${firstForecast > 0 ? `<rect x="${pad.l + band * firstForecast}" y="${pad.t - 18}" width="${band * (months.length - firstForecast)}" height="${ph + 18}" fill="rgba(255,255,255,0.025)" rx="6"/>
      <text class="tick" x="${pad.l + band * firstForecast + 8}" y="${pad.t - 5}">Forecast</text>` : ""}
    ${ticks.map((v) => `<line class="${v === 0 ? "zero" : "grid"}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${money(v, { compact: true })}</text>`).join("")}
    ${months.map((m, i) => i % labelEvery === (months.length - 1) % labelEvery ? `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle" ${m.current ? 'style="fill:var(--text);font-weight:600"' : ""}>${esc(monthName(m.month))}</text>` : "").join("")}
    ${bars}
    <path d="${line(0, cur)}" fill="none" stroke="${SERIES.profit}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line(cur, months.length - 1)}" fill="none" stroke="${SERIES.profit}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
    ${pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" fill="${SERIES.profit}" stroke="var(--surface)" stroke-width="2"/>`).join("")}
    ${months.map((m, i) => `<rect class="hit" data-i="${i}" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ph}" rx="4"/>`).join("")}
  </svg><div class="tooltip" hidden></div>`;

  const tip = el.querySelector(".tooltip");
  el.querySelectorAll(".hit").forEach((h) => {
    h.onmouseenter = () => {
      const m = months[Number(h.dataset.i)];
      const sub = (b) => Object.entries(b).sort((a, c) => c[1] - a[1]).map(([k, v]) => `<div class="row sub"><span>${esc(k)}</span><span>${money(v, { exact: v > 0 && v < 100 })}</span></div>`).join("");
      tip.innerHTML = `<h4>${esc(monthName(m.month, true))}${m.forecast ? ' <span class="tag">forecast</span>' : m.current ? ' <span class="tag">this month</span>' : ""}</h4>
        <div class="row"><span class="key"><i style="background:${SERIES.in}"></i>Money in</span><b>${money(m.in)}</b></div>${sub(m.breakdown.in)}
        <div class="row"><span class="key"><i style="background:${SERIES.out}"></i>Money out</span><b>${money(m.out, { exact: m.out > 0 && m.out < 100 })}</b></div>${sub(m.breakdown.out)}
        <div class="row total"><span class="key"><i style="background:${SERIES.profit}"></i>Profit</span><b>${money(m.profit)}</b></div>`;
      tip.hidden = false;
      const i = Number(h.dataset.i);
      const left = x(i) + band / 2 + 8;
      tip.style.left = `${left + 220 > W ? x(i) - band / 2 - 8 - tip.offsetWidth : left}px`;
      tip.style.top = `${pad.t}px`;
      h.classList.add("on");
    };
    h.onmouseleave = () => { tip.hidden = true; h.classList.remove("on"); };
  });
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const el = document.querySelector("#chart");
    if (el && state.money) drawChart(el, state.money.summary.months);
  }, 150);
});

function countUp(el) {
  const to = Number(el?.dataset.to);
  if (!el || !to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - start) / 900);
    el.textContent = money(Math.round(to * (1 - (1 - k) ** 3) / 100) * 100);
    if (k < 1) requestAnimationFrame(tick);
    else el.textContent = money(to);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- actions

function bindMoney() {
  view.querySelector("#add-client").onclick = addClient;
  view.querySelector("#add-cost").onclick = addEntry;
  view.querySelector("#add-cost-2").onclick = addEntry;
  view.querySelector("#edit-goal").onclick = editGoal;
  view.querySelectorAll("[data-stop-client]").forEach((b) => b.onclick = () => askDate(
    "When did they stop paying?", "Their monthly stops from this date. They keep the website; everything else switches off.",
    (date) => api(`/api/money/clients/${encodeURIComponent(b.dataset.stopClient)}`, { method: "PATCH", body: JSON.stringify({ cancelled_on: date }) })));
  view.querySelectorAll("[data-stop-entry]").forEach((b) => b.onclick = () => askDate(
    "When did it stop?", "No more monthly payments from this date.",
    (date) => api(`/api/money/entries/${encodeURIComponent(b.dataset.stopEntry)}`, { method: "PATCH", body: JSON.stringify({ ended_on: date }) })));
  view.querySelectorAll("[data-del-client]").forEach((b) => b.onclick = () => remove(`/api/money/clients/${encodeURIComponent(b.dataset.delClient)}`, "Delete this client and all their payments from the Money page?"));
  view.querySelectorAll("[data-del-entry]").forEach((b) => b.onclick = () => remove(`/api/money/entries/${encodeURIComponent(b.dataset.delEntry)}`, "Delete this entry?"));
}

async function remove(path, question) {
  if (!confirm(question)) return;
  try {
    await api(path, { method: "DELETE" });
    await moneyPage();
  } catch (err) {
    alert(err.message);
  }
}

const foot = (label) => `<div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">${label}</button></div>`;
const head = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>`;

/** Submit a modal form: run save(form), show errors inline, close and refresh on success. */
function onSubmit(d, save, after = () => {}) {
  const form = d.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = d.querySelector(".error");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    err.hidden = true;
    try {
      await save(form);
      d.close();
      await moneyPage();
      after();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
}

async function addClient() {
  let leads = [];
  try {
    leads = (await api("/api/leads")).leads.filter((l) => !l.excluded);
  } catch { /* the form still works without suggestions */ }
  const hot = ["call booked", "replied", "won", "contacted"];
  leads.sort((a, b) => (hot.indexOf(a.status) + 1 || 9) - (hot.indexOf(b.status) + 1 || 9));
  const d = modal(`<form>${head("Add a client")}
    <div class="modal-body">
      <div><label for="c-name">Business</label><input id="c-name" list="c-leads" required minlength="2" maxlength="120" placeholder="Start typing a lead's name…" autocomplete="off">
        <datalist id="c-leads">${leads.slice(0, 300).map((l) => `<option value="${esc(l.name)}">${esc(l.town || "")}${l.status !== "new" ? ` · ${esc(l.status)}` : ""}</option>`).join("")}</datalist>
        <p class="hint" id="c-lead-note">If they're one of your leads, that lead is marked as won.</p></div>
      <div><label>Package</label><div class="pkg-options">${Object.entries(PACKAGES).map(([k, p], i) => `
        <label class="pkg"><input type="radio" name="pkg" value="${k}" ${i === 0 ? "checked" : ""}><span><b>${p.label}</b><small>${p.note}</small></span></label>`).join("")}</div></div>
      <div class="field-row">
        <div><label for="c-build">Build fee (£)</label><input id="c-build" inputmode="decimal" required></div>
        <div><label for="c-monthly">Monthly (£)</label><input id="c-monthly" inputmode="decimal" required></div>
        <div><label for="c-free">Free days</label><input id="c-free" type="number" min="0" max="365" required></div>
      </div>
      <div><label for="c-paid">Date they paid</label><input id="c-paid" type="date" value="${today()}" required></div>
      <p class="error" hidden></p>
    </div>${foot("Add client")}</form>`);
  const fill = () => {
    const p = PACKAGES[d.querySelector("input[name=pkg]:checked").value];
    d.querySelector("#c-build").value = p.build;
    d.querySelector("#c-monthly").value = p.monthly;
    d.querySelector("#c-free").value = p.freeDays;
  };
  d.querySelectorAll("input[name=pkg]").forEach((r) => r.onchange = fill);
  fill();
  const match = () => leads.find((l) => l.name.toLowerCase() === d.querySelector("#c-name").value.trim().toLowerCase());
  d.querySelector("#c-name").oninput = () => {
    const l = match();
    d.querySelector("#c-lead-note").textContent = l ? `Linked to your lead in ${l.town || l.search_town}: it'll be marked as won.` : "If they're one of your leads, that lead is marked as won.";
  };
  onSubmit(d, (form) => api("/api/money/clients", {
    method: "POST",
    body: JSON.stringify({
      name: form.querySelector("#c-name").value.trim(),
      package: form.querySelector("input[name=pkg]:checked").value,
      build: form.querySelector("#c-build").value,
      monthly: form.querySelector("#c-monthly").value,
      free_days: Number(form.querySelector("#c-free").value),
      paid_on: form.querySelector("#c-paid").value,
      place_id: match()?.place_id || "",
    }),
  }), () => { confetti(); toast("Client added. Get that money."); });
}

function addEntry() {
  const d = modal(`<form>${head("Add money in or out")}
    <div class="modal-body">
      <div class="seg" style="align-self:start"><button type="button" class="active" data-kind="out">Cost</button><button type="button" data-kind="in">Money in</button></div>
      <div><label for="e-label">What for</label><input id="e-label" required minlength="2" maxlength="120" placeholder="Google Workspace mailboxes"></div>
      <div class="field-row">
        <div id="e-cat-wrap"><label for="e-cat">Category</label><select id="e-cat">${COST_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
        <div><label for="e-amount">Amount (£)</label><input id="e-amount" inputmode="decimal" required placeholder="18.50"></div>
        <div><label for="e-date">Date</label><input id="e-date" type="date" value="${today()}" required></div>
      </div>
      <label class="check-line"><input type="checkbox" id="e-monthly"> Repeats every month</label>
      <p class="error" hidden></p>
    </div>${foot("Add")}</form>`);
  let kind = "out";
  d.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => {
    kind = b.dataset.kind;
    d.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("active", x === b));
    d.querySelector("#e-cat-wrap").hidden = kind === "in";
    d.querySelector("#e-label").placeholder = kind === "in" ? "Logo design for a client" : "Google Workspace mailboxes";
  });
  onSubmit(d, (form) => api("/api/money/entries", {
    method: "POST",
    body: JSON.stringify({
      kind, label: form.querySelector("#e-label").value.trim(), category: form.querySelector("#e-cat").value,
      amount: form.querySelector("#e-amount").value, on_date: form.querySelector("#e-date").value, monthly: form.querySelector("#e-monthly").checked,
    }),
  }));
}

function editGoal() {
  const d = modal(`<form>${head("Monthly recurring goal")}
    <div class="modal-body">
      <div><label for="g-goal">Monthly retainer income you're aiming for (£)</label><input id="g-goal" inputmode="decimal" required value="${state.money.summary.goal / 100}"></div>
      <p class="hint" style="margin:0">£5,000 a month is about 20 clients on £249/mo.</p>
      <p class="error" hidden></p>
    </div>${foot("Save")}</form>`);
  onSubmit(d, (form) => api("/api/money/goal", { method: "PUT", body: JSON.stringify({ goal: form.querySelector("#g-goal").value }) }));
}

function askDate(title, note, save) {
  const d = modal(`<form>${head(title)}
    <div class="modal-body"><div><label for="a-date">Date</label><input id="a-date" type="date" value="${today()}" required></div>
      <p class="hint" style="margin:0">${esc(note)}</p><p class="error" hidden></p></div>${foot("Save")}</form>`);
  onSubmit(d, (form) => save(form.querySelector("#a-date").value));
}
