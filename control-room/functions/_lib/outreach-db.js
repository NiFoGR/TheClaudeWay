// Outreach: database side. Loads everything the Outreach page and the weekly Claude report need, keeps the test
// up to date (pauses, retirements, ending a test), and renders versions on real leads.
import { decide, eligibility, facts, footer, gate, render, versionStats, withChances, POSITIVE, NEGATIVE } from "./outreach.js";
import { SEED_FOLLOWUPS, SEED_TEST } from "./outreach-seed.js";
import { getSetting, putSetting } from "./stripe.js";
import { leadRow, now } from "./util.js";

const FOUR_WEEKS = 28 * 86400000;

/** Load the starting versions once, as proposals for the owner to approve. */
async function seed(DB) {
  const any = await DB.prepare("SELECT id FROM outreach_versions LIMIT 1").first();
  if (any) return;
  const ts = now();
  await DB.batch([
    ...SEED_TEST.map((v) => DB.prepare(
      "INSERT INTO outreach_versions (id, step, name, hypothesis, subject, body, status, author, created_at) VALUES (?, 1, ?, ?, ?, ?, 'proposed', 'seed', ?)"
    ).bind(crypto.randomUUID(), v.name, v.hypothesis, v.subject, v.body, ts)),
    ...SEED_FOLLOWUPS.map((v, i) => DB.prepare(
      "INSERT INTO outreach_versions (id, step, name, hypothesis, subject, body, status, author, created_at) VALUES (?, ?, ?, '', '', ?, 'proposed', 'seed', ?)"
    ).bind(crypto.randomUUID(), v.step, v.name, v.body, `${ts}#${i}`)),
  ]);
}

const replyClass = (r) => r.owner_class || r.auto_class || null;

/** The competitor and grid size for a lead, from its latest Map Rank scan. */
export async function mapContext(DB, placeId) {
  const row = await DB.prepare(
    `SELECT b.name, b.top3_pct, s.grid FROM lead_map_rank m
     JOIN scans s ON s.id = m.scan_id
     JOIN scan_businesses b ON b.scan_id = m.scan_id AND b.place_id != m.place_id
     WHERE m.place_id = ? ORDER BY b.top3_pct DESC, b.avg_rank ASC LIMIT 1`
  ).bind(placeId).first();
  return row ? { competitor: { name: row.name, top3_pct: row.top3_pct }, spots: row.grid * row.grid } : {};
}

export async function senderSettings(DB) {
  return (await getSetting(DB, "outreach_sender")) || {};
}

/** Render one version on up to n real leads (eligible ones first), each with its quality-gate result. */
export async function previews(DB, version, n = 5) {
  const sender = await senderSettings(DB);
  const { results } = await DB.prepare(
    `SELECT leads.* FROM leads WHERE excluded = 0 AND email IS NOT NULL AND email != ''
     ORDER BY (company_number IS NOT NULL) DESC, quality_score DESC LIMIT 40`
  ).all();
  const out = [];
  for (const row of results) {
    if (out.length >= n) break;
    const lead = leadRow(row);
    const f = facts(lead, { ...(await mapContext(DB, lead.place_id)), sender: { first: sender.first || "Nik" } });
    const r = render(version, f);
    if (!r) continue;
    out.push({ place_id: lead.place_id, name: lead.name, subject: r.subject, body: r.body, issues: gate(r, version.step, { rendered: true, lead: f }) });
  }
  return out;
}

/**
 * Gate a version: the template itself, plus rendered on up to 5 real leads.
 * issues = what blocks approval (any template problem, or failing for most leads).
 * warnings = leads it fails for: those leads just get another version instead.
 */
export async function check(DB, version) {
  const issues = gate(version, version.step).map((i) => `Template: ${i}`);
  const rendered = await previews(DB, version, 5);
  const failing = rendered.filter((p) => p.issues.length);
  const warnings = failing.flatMap((p) => p.issues.map((i) => `For ${p.name}: ${i}`));
  if (rendered.length && failing.length > rendered.length / 2) {
    issues.push(`Fails the check for ${failing.length} of ${rendered.length} leads tried:`, ...warnings);
  }
  return { issues: [...new Set(issues)], warnings, previews: rendered };
}

/** Apply the decision rules to the open test (pauses, retirements, ending it). Returns the actions taken. */
async function reconcile(DB, test, versions, stats) {
  const actions = decide(test, stats);
  if (!actions.length) return actions;
  const ts = now();
  const stmts = [];
  for (const a of actions) {
    if (a.type === "pause" || a.type === "retire") {
      stmts.push(DB.prepare("UPDATE outreach_versions SET status = ?, status_reason = ?, decided_at = ? WHERE id = ?")
        .bind(a.type === "pause" ? "paused" : "retired", a.reason, ts, a.id));
    }
    if (a.type === "end") {
      const kept = stats.find((s) => s.id === a.keep);
      const others = stats.filter((s) => s.status === "live" && s.id !== a.keep && !actions.some((x) => x.id === s.id));
      const name = (id) => versions.find((v) => v.id === id)?.name || id;
      const pct = (s) => `${(100 * s.positive / Math.max(1, s.counted)).toFixed(1)}%`;
      const summary = `Kept "${name(kept.id)}" (${kept.positive}/${kept.counted}, ${pct(kept)})` +
        (others.length ? ` over ${others.map((o) => `"${name(o.id)}" (${o.positive}/${o.counted}, ${pct(o)})`).join(", ")}` : "") + `. ${a.reason}.`;
      const next = crypto.randomUUID();
      stmts.push(DB.prepare("UPDATE outreach_tests SET ended_at = ?, kept_id = ?, summary = ?, results = ? WHERE id = ?")
        .bind(ts, kept.id, summary, JSON.stringify(stats), test.id));
      for (const o of others) {
        stmts.push(DB.prepare("UPDATE outreach_versions SET status = 'retired', status_reason = 'Lost the test', decided_at = ? WHERE id = ?").bind(ts, o.id));
      }
      // the winner carries into the next test, starting fresh against the next challenger
      stmts.push(DB.prepare("INSERT INTO outreach_tests (id, started_at) VALUES (?, ?)").bind(next, ts));
      stmts.push(DB.prepare("UPDATE outreach_versions SET test_id = ? WHERE id = ?").bind(next, kept.id));
    }
  }
  await DB.batch(stmts);
  return actions;
}

/** Everything about outreach in one object (the Outreach page and the weekly report use this). */
export async function loadOutreach(DB, { apply = true } = {}) {
  await seed(DB);
  let [tests, versions] = await Promise.all([
    DB.prepare("SELECT * FROM outreach_tests ORDER BY started_at DESC").all().then((r) => r.results),
    DB.prepare("SELECT * FROM outreach_versions ORDER BY step, created_at").all().then((r) => r.results),
  ]);
  let test = tests.find((t) => !t.ended_at) || null;
  const loadStats = async () => {
    if (!test) return [];
    const testVersions = versions.filter((v) => v.step === 1 && v.test_id === test.id);
    const [sends, replies] = await Promise.all([
      DB.prepare("SELECT version_id, place_id, sent_at FROM outreach_sends WHERE step = 1 AND status = 'sent' AND test_id = ?").bind(test.id).all().then((r) => r.results),
      DB.prepare("SELECT r.place_id, r.received_at, r.owner_class, r.auto_class FROM outreach_replies r JOIN outreach_sends s ON s.place_id = r.place_id AND s.step = 1 AND s.test_id = ?").bind(test.id).all().then((r) => r.results),
    ]);
    return withChances(versionStats(testVersions, sends, replies.map((r) => ({ ...r, cls: replyClass(r) }))));
  };
  let stats = await loadStats();
  let actions = [];
  if (apply && test) {
    actions = await reconcile(DB, test, versions, stats);
    if (actions.length) return loadOutreach(DB, { apply: false }); // reload after changes
  }

  const [sendCounts, firstSend, sender, replies] = await Promise.all([
    DB.prepare("SELECT step, status, COUNT(*) AS n FROM outreach_sends GROUP BY step, status").all().then((r) => r.results),
    DB.prepare("SELECT MIN(sent_at) AS first FROM outreach_sends WHERE status = 'sent'").first(),
    senderSettings(DB),
    DB.prepare("SELECT r.*, l.name FROM outreach_replies r LEFT JOIN leads l ON l.place_id = r.place_id ORDER BY received_at DESC LIMIT 50").all().then((r) => r.results),
  ]);
  return {
    test,
    tests: tests.filter((t) => t.ended_at),
    versions,
    stats,
    actions,
    sendCounts,
    sender,
    replies,
    guessedAllowed: !!firstSend?.first && Date.now() - Date.parse(firstSend.first) >= FOUR_WEEKS,
    footer: footer(sender),
  };
}

/** How many leads outreach could email right now, and why the rest can't be. */
export async function eligibilitySummary(DB, guessedAllowed) {
  const [{ results }, sup, contacted] = await Promise.all([
    DB.prepare("SELECT * FROM leads WHERE excluded = 0").all(),
    DB.prepare("SELECT value FROM suppression").all(),
    DB.prepare("SELECT DISTINCT place_id FROM outreach_sends").all(),
  ]);
  const ctx = {
    suppressed: new Set(sup.results.map((r) => String(r.value).toLowerCase())),
    contacted: new Set(contacted.results.map((r) => r.place_id)),
    guessedAllowed,
  };
  const reasons = {};
  let eligible = 0;
  for (const row of results) {
    const e = eligibility(leadRow(row), ctx);
    if (e.ok) eligible++;
    else reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  }
  return { eligible, total: results.length, reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]) };
}

/** Approve a version: gate it, then make it live (step 1 joins the open test, starting one if needed). */
export async function approve(DB, version) {
  const { issues } = await check(DB, version);
  if (issues.length) return { issues };
  const ts = now();
  if (version.step === 1) {
    let test = await DB.prepare("SELECT * FROM outreach_tests WHERE ended_at IS NULL").first();
    if (!test) {
      test = { id: crypto.randomUUID(), started_at: ts };
      await DB.prepare("INSERT INTO outreach_tests (id, started_at) VALUES (?, ?)").bind(test.id, ts).run();
    }
    const live = await DB.prepare("SELECT COUNT(*) AS n FROM outreach_versions WHERE step = 1 AND status = 'live'").first();
    if (live.n >= 3) return { issues: ["Already 3 versions in the test. Retire or pause one first."] };
    // a new challenger restarts the clock: every version in the test gets a fair, equal run from now
    await DB.batch([
      DB.prepare("UPDATE outreach_versions SET status = 'live', test_id = ?, approved_at = ?, status_reason = NULL WHERE id = ?").bind(test.id, ts, version.id),
      DB.prepare("UPDATE outreach_tests SET started_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM outreach_sends WHERE test_id = ?)").bind(ts, test.id, test.id),
    ]);
  } else {
    await DB.prepare("UPDATE outreach_versions SET status = 'live', approved_at = ?, status_reason = NULL WHERE id = ?").bind(ts, version.id).run();
  }
  return { issues: [] };
}

export { putSetting, POSITIVE, NEGATIVE, replyClass };
