// GET /api/sites → the Sites list (stage 10, docs/rebuild/09-build.md section 13, Task 24), behind the login:
// [{client_id, name, status_label, countdown: {label, level}, host, live, enquiries_30d, status, package, is_test,
// due_live_at, live_at}], soonest due first (sites without a due date last). The work is listSites (_lib/sites/db.js);
// labels and countdowns are the Site page's (sites/[client_id].js). Tested in control-room/tests/sites-api.test.mjs.
// D1: 1 query.
import { listSites } from "../_lib/sites/db.js";
import { db, json } from "../_lib/util.js";
import { nowOf, siteCountdown, statusLabel } from "./sites/[client_id].js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const rows = await listSites(DB, now);
  return json(rows.map((s) => ({
    client_id: s.client_id,
    name: s.name ?? "",
    status_label: statusLabel(s),
    countdown: siteCountdown(s, now),
    host: s.host ?? null,
    live: Boolean(s.live_at),
    enquiries_30d: s.enquiries_30d,
    status: s.status,
    package: s.package ?? null,
    is_test: Number(s.is_test) === 1,
    due_live_at: s.due_live_at ?? null,
    live_at: s.live_at ?? null,
  })));
}
