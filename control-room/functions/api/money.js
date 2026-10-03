// GET /api/money → everything the Money page shows (see _lib/money.js for the maths).
import { loadMoney } from "../_lib/money.js";
import { db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  return json(await loadMoney(await db(env)));
}
