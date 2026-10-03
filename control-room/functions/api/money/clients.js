// POST /api/money/clients {name, package, build, monthly, free_days, paid_on, place_id?, notes?} → a new paying client.
// If they came from a lead, that lead is marked "won".
import { PACKAGES, isDate, toPence } from "../../_lib/money.js";
import { bad, db, json, now } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const pkg = PACKAGES[body.package];
  const build = toPence(body.build);
  const monthly = toPence(body.monthly);
  const freeDays = Number(body.free_days);
  if (name.length < 2 || name.length > 120) return bad("Type the business name");
  if (!pkg) return bad("Pick a package");
  if (Number.isNaN(build)) return bad("Build fee must be an amount in pounds, e.g. 1950");
  if (Number.isNaN(monthly)) return bad("Monthly fee must be an amount in pounds, e.g. 249");
  if (!Number.isInteger(freeDays) || freeDays < 0 || freeDays > 365) return bad("Free days must be a whole number from 0 to 365");
  if (!isDate(body.paid_on)) return bad("Pick the date they paid");

  const DB = await db(env);
  const id = crypto.randomUUID();
  const placeId = String(body.place_id || "") || null;
  const stmts = [
    DB.prepare(
      `INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, placeId, body.package, build, monthly, freeDays, body.paid_on, String(body.notes || "").slice(0, 2000), now()),
  ];
  if (placeId) stmts.push(DB.prepare("UPDATE leads SET status = 'won', updated_at = ? WHERE place_id = ?").bind(now(), placeId));
  await DB.batch(stmts);
  return json({ client: await DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first() }, 201);
}
