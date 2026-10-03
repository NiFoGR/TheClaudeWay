// Money maths for the Money and Home pages. Pure functions on rows from D1; all amounts in pence.
//
// Income  = build fees (on the day paid) + retainers (monthly, starting once the free days end, until cancelled)
//           + any other money in. Costs = Google API (estimated from logged calls) + costs you add.
// Forecast months only count what is already committed: active clients, monthly costs, average Google spend.

// Google Places API (New) list prices, USD per 1,000 calls, and the free calls each SKU gets every month.
// SKUs match lead-manager/aetos_leads/usage.py. Check https://developers.google.com/maps/billing-and-pricing/pricing
export const GOOGLE_SKUS = {
  text_search_enterprise: { usdPer1000: 35, freePerMonth: 1000, label: "Lead searches" },
  text_search_pro: { usdPer1000: 32, freePerMonth: 5000, label: "Finding town centres" },
  text_search_ids: { usdPer1000: 0, freePerMonth: Infinity, label: "Map Rank grid points (free)" },
  place_details_enterprise: { usdPer1000: 20, freePerMonth: 1000, label: "Competitor names on heatmaps" },
};
export const USD_TO_GBP = 0.75; // approximate; Google bills in your account's currency

export const PACKAGES = {
  full: { label: "Full Package", build: 195000, monthly: 24900, freeDays: 60 },
  weekend: { label: "Weekend deal", build: 175000, monthly: 24900, freeDays: 90 },
  website: { label: "Website Only", build: 175000, monthly: 0, freeDays: 0 },
};
export const COST_CATEGORIES = ["Mailboxes", "Domains", "Tools & software", "Ads", "Other"];
export const DEFAULT_GOAL = 500000; // £5,000 a month recurring
const PAST_MONTHS = 5;
const FUTURE_MONTHS = 6;

// ---------------------------------------------------------------- dates (YYYY-MM-DD strings, UTC)

const pad = (n) => String(n).padStart(2, "0");
const toIso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => new Date(`${s}T00:00:00Z`);
export const monthOf = (iso) => iso.slice(0, 7);

export function addDays(iso, days) {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Same day-of-month n months later, clamped (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso, n) {
  const d = parse(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return toIso(target);
}

const monthKeyPlus = (month, n) => monthOf(addMonths(`${month}-01`, n));

/** Dates of a monthly payment from `first` up to `until` (inclusive), stopping before `stop` if given. */
function monthly(first, until, stop) {
  const dates = [];
  for (let i = 0; i < 1200; i++) {
    const d = addMonths(first, i);
    if (d > until || (stop && d >= stop)) break;
    dates.push(d);
  }
  return dates;
}

// ---------------------------------------------------------------- the ledger

export function clientStatus(c, today) {
  const firstCharge = addDays(c.paid_on, c.free_days);
  if (c.cancelled_on && c.cancelled_on <= today) return { key: "stopped", firstCharge };
  if (!c.monthly_pence) return { key: "one-off", firstCharge };
  return { key: firstCharge <= today ? "paying" : "free", firstCharge };
}

/** Every payment in and out, from the first record up to `until`.
 * Clients who pay through Stripe (stripe_customer set) count what Stripe actually received (`payments`) up to
 * today; their schedule is only used for the forecast. Clients added by hand follow their schedule throughout. */
export function ledger({ clients = [], entries = [], payments = [], until, today = "9999-12-31" }) {
  const items = [];
  const names = Object.fromEntries(clients.filter((c) => c.stripe_customer).map((c) => [c.stripe_customer, c.name]));
  for (const c of clients) {
    const viaStripe = !!c.stripe_customer;
    if (!viaStripe) items.push({ date: c.paid_on, kind: "in", category: "Website builds", label: c.name, pence: c.build_fee_pence });
    if (c.monthly_pence > 0) {
      for (const date of monthly(addDays(c.paid_on, c.free_days), until, c.cancelled_on)) {
        if (!viaStripe || date > today) items.push({ date, kind: "in", category: "Monthly retainers", label: c.name, pence: c.monthly_pence });
      }
    }
  }
  for (const p of payments) {
    const label = names[p.stripe_customer] || p.name;
    items.push({ date: p.paid_on, kind: "in", category: p.category, label, pence: p.amount_pence });
    if (p.fee_pence) items.push({ date: p.paid_on, kind: "out", category: "Stripe fees", label, pence: p.fee_pence });
  }
  for (const e of entries) {
    const dates = e.monthly ? monthly(e.on_date, until, e.ended_on) : e.on_date <= until ? [e.on_date] : [];
    for (const date of dates) items.push({ date, kind: e.kind, category: e.category, label: e.label, pence: e.amount_pence });
  }
  return items;
}

/** Google cost per month in pence, after each SKU's free monthly allowance. usage rows: {month, sku, calls}. */
export function googleCosts(usage = []) {
  const byMonth = {};
  for (const u of usage) {
    const sku = GOOGLE_SKUS[u.sku];
    if (!sku) continue;
    const m = (byMonth[u.month] ||= { pence: 0, calls: 0, skus: {} });
    if (sku.usdPer1000) m.calls += u.calls; // free SKUs don't count towards anything
    m.skus[u.sku] = (m.skus[u.sku] || 0) + u.calls;
  }
  for (const m of Object.values(byMonth)) {
    m.pence = Math.round(Object.entries(m.skus).reduce((sum, [key, calls]) => {
      const sku = GOOGLE_SKUS[key];
      return sum + Math.max(0, calls - sku.freePerMonth) * sku.usdPer1000 / 1000 * USD_TO_GBP * 100;
    }, 0));
  }
  return byMonth;
}

const sum = (items) => items.reduce((s, i) => s + i.pence, 0);

function addTo(bucket, item) {
  bucket[item.kind] += item.pence;
  const b = bucket.breakdown[item.kind];
  b[item.category] = (b[item.category] || 0) + item.pence;
}

/** Everything the Money page shows. */
export function summarise({ clients = [], entries = [], payments = [], usage = [], pipeline = {}, goal = DEFAULT_GOAL, today }) {
  const thisMonth = monthOf(today);
  const horizon = addDays(`${monthKeyPlus(thisMonth, FUTURE_MONTHS + 1)}-01`, -1);
  const items = ledger({ clients, entries, payments, until: horizon, today });
  const google = googleCosts(usage);
  const recentGoogle = [0, 1, 2].map((i) => google[monthKeyPlus(thisMonth, -i)]?.pence || 0);
  const googleForecast = Math.round(recentGoogle.reduce((a, b) => a + b, 0) / 3);

  // months: a few past, this one, and the forecast
  const months = [];
  for (let i = -PAST_MONTHS; i <= FUTURE_MONTHS; i++) {
    const month = monthKeyPlus(thisMonth, i);
    const bucket = { month, in: 0, out: 0, current: i === 0, forecast: i > 0, breakdown: { in: {}, out: {} } };
    items.filter((it) => monthOf(it.date) === month).forEach((it) => addTo(bucket, it));
    const g = i > 0 ? googleForecast : google[month]?.pence || 0;
    if (g) addTo(bucket, { kind: "out", category: "Google API", pence: g });
    bucket.profit = bucket.in - bucket.out;
    months.push(bucket);
  }

  const toDate = items.filter((i) => i.date <= today);
  const monthToDate = toDate.filter((i) => monthOf(i.date) === thisMonth);
  const googleThisMonth = google[thisMonth]?.pence || 0;
  const inThisMonth = sum(monthToDate.filter((i) => i.kind === "in"));
  const outThisMonth = sum(monthToDate.filter((i) => i.kind === "out")) + googleThisMonth;
  const lastMonth = months[PAST_MONTHS - 1];
  const googleAllTime = Object.values(google).reduce((s, m) => s + m.pence, 0);

  const statuses = clients.map((c) => ({ ...c, ...clientStatus(c, today) }));
  const mrr = statuses.filter((c) => c.key === "paying").reduce((s, c) => s + c.monthly_pence, 0);
  const mrrSoon = statuses.filter((c) => c.key === "free").reduce((s, c) => s + c.monthly_pence, 0);
  const allIn = sum(toDate.filter((i) => i.kind === "in"));
  const allOut = sum(toDate.filter((i) => i.kind === "out")) + googleAllTime;

  return {
    today,
    month: thisMonth,
    thisMonth: {
      in: inThisMonth,
      out: outThisMonth,
      profit: inThisMonth - outThisMonth,
      expectedProfit: months[PAST_MONTHS].profit,
      google: googleThisMonth,
      googleCalls: google[thisMonth]?.calls || 0,
      googleSkus: google[thisMonth]?.skus || {},
    },
    lastMonthProfit: lastMonth.profit,
    allTime: { in: allIn, out: allOut, profit: allIn - allOut },
    mrr,
    mrrSoon,
    activeClients: statuses.filter((c) => c.key === "paying" || c.key === "free").length,
    totalClients: clients.length,
    goal,
    forecastProfit: months.filter((m) => m.forecast).reduce((s, m) => s + m.profit, 0),
    months,
    clients: statuses,
    // the next few payments due in, for the "coming up" list
    upcoming: items.filter((i) => i.kind === "in" && i.date > today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3),
    pipeline: {
      callsBooked: pipeline.callsBooked || 0,
      replied: pipeline.replied || 0,
      value: (pipeline.callsBooked || 0) * PACKAGES.full.build,
      monthlyValue: (pipeline.callsBooked || 0) * PACKAGES.full.monthly,
    },
  };
}

// ---------------------------------------------------------------- loading from D1

export async function loadMoney(DB, today = new Date().toISOString().slice(0, 10)) {
  const [clients, entries, usage, pipe, goal, payments] = await DB.batch([
    DB.prepare(`SELECT clients.*, l.stripe_customer, l.failed_on FROM clients LEFT JOIN client_links l ON l.client_id = clients.id
                ORDER BY clients.paid_on DESC, clients.created_at DESC`),
    DB.prepare("SELECT * FROM money ORDER BY on_date DESC, created_at DESC"),
    DB.prepare("SELECT substr(created_at, 1, 7) AS month, sku, SUM(calls) AS calls FROM api_usage GROUP BY month, sku"),
    DB.prepare("SELECT SUM(status = 'call booked') AS callsBooked, SUM(status = 'replied') AS replied FROM leads WHERE excluded = 0"),
    DB.prepare("SELECT value FROM settings WHERE key = 'mrr_goal_pence'"),
    // name from the client where we know it (an invoice can arrive before the checkout that creates the client)
    DB.prepare(`SELECT payments.*, COALESCE(c.name, payments.name) AS name FROM payments
                LEFT JOIN client_links l ON l.stripe_customer = payments.stripe_customer LEFT JOIN clients c ON c.id = l.client_id
                ORDER BY payments.paid_on DESC`),
  ]);
  const summary = summarise({
    clients: clients.results,
    entries: entries.results,
    payments: payments.results,
    usage: usage.results,
    pipeline: pipe.results[0] || {},
    goal: Number(goal.results[0]?.value) || DEFAULT_GOAL,
    today,
  });
  return { summary, entries: entries.results, payments: payments.results.slice(0, 50) };
}

/** "£1,950.00" → 195000. Accepts numbers or strings with £ and commas. Returns NaN if not a sensible amount. */
export function toPence(value) {
  const n = Number(String(value ?? "").replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) : NaN;
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));
