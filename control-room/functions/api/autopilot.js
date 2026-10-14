// GET/PUT /api/autopilot → the daily autopilot's territory: {on, trade, towns, next, max}. Each morning the "Daily
// autopilot" workflow searches the next town not searched in the last 30 days (lead-manager/aetos_leads/autopilot.py).
import { getSetting, putSetting } from "../_lib/stripe.js";
import { bad, db, json } from "../_lib/util.js";

// same defaults as autopilot.py
export const DEFAULT_TERRITORY = {
  on: true, trade: "landscaper", next: 0, max: 60,
  towns: ["Warrington", "Widnes", "Runcorn", "St Helens", "Wigan", "Leigh", "Northwich", "Altrincham", "Sale", "Stockport",
    "Chester", "Crewe", "Bolton", "Bury", "Salford", "Knutsford", "Macclesfield", "Ellesmere Port"],
};

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const t = { ...DEFAULT_TERRITORY, ...((await getSetting(DB, "territory")) || {}) };
  const last = await DB.prepare("SELECT town, status, created_at FROM jobs WHERE lower(trade) = lower(?) ORDER BY created_at DESC LIMIT 1").bind(t.trade).first();
  return json({ territory: t, upcoming: t.towns.length ? t.towns[t.next % t.towns.length] : "", last });
}

export async function onRequestPut({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const trade = String(b.trade || "").trim();
  const towns = [...new Set((Array.isArray(b.towns) ? b.towns : String(b.towns || "").split(/\n|,/)).map((t) => String(t).trim()).filter(Boolean))].slice(0, 200);
  const max = Number(b.max) || 60;
  if (trade.length < 2 || trade.length > 60) return bad("Type the niche to search, e.g. landscaper");
  if (!towns.length) return bad("Add at least one town (one per line)");
  if (max < 10 || max > 300) return bad("Leads per search must be between 10 and 300");
  const DB = await db(env);
  const old = { ...DEFAULT_TERRITORY, ...((await getSetting(DB, "territory")) || {}) };
  // keep the place in the list when only the on/off or size changes; start from the top for a new trade or list
  const same = old.trade.toLowerCase() === trade.toLowerCase() && old.towns.join("|") === towns.join("|");
  const t = { on: !!b.on, trade, towns, max, next: same ? old.next % towns.length : 0 };
  await putSetting(DB, "territory", t);
  return json({ territory: t });
}
