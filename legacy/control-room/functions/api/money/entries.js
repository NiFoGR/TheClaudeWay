// POST /api/money/entries {kind: in|out, category, label, amount, on_date, monthly} → a cost (or other income).
import { COST_CATEGORIES, isDate, toPence } from "../../_lib/money.js";
import { bad, db, json, now } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const kind = body.kind === "in" ? "in" : body.kind === "out" ? "out" : "";
  const label = String(body.label || "").trim();
  const amount = toPence(body.amount);
  const category = kind === "in" ? "Other income" : String(body.category || "");
  if (!kind) return bad("Is it money in or money out?");
  if (label.length < 2 || label.length > 120) return bad("Say what it was for, e.g. Google Workspace mailboxes");
  if (!(amount > 0)) return bad("Amount must be in pounds, e.g. 18.50");
  if (kind === "out" && !COST_CATEGORIES.includes(category)) return bad("Pick a category");
  if (!isDate(body.on_date)) return bad("Pick a date");

  const DB = await db(env);
  const id = crypto.randomUUID();
  await DB.prepare(
    "INSERT INTO money (id, kind, category, label, amount_pence, on_date, monthly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, kind, category, label, amount, body.on_date, body.monthly ? 1 : 0, now()).run();
  return json({ entry: await DB.prepare("SELECT * FROM money WHERE id = ?").bind(id).first() }, 201);
}
