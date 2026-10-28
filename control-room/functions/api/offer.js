// GET /api/offer → {packages} (login required, like every /api/ path but /api/tick): the prices from _lib/offer.js,
// for every page but Money (which reads the same PACKAGES from /api/money's summary.packages). Pure: no database.
import { PACKAGES } from "../_lib/offer.js";
import { json } from "../_lib/util.js";

export async function onRequestGet() {
  return json({ packages: PACKAGES });
}
