// The weekly report Claude reads (on the owner's subscription) to judge the test and propose challengers.
import { RULES, STEPS } from "./outreach.js";
import { replyClass } from "./outreach-db.js";

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
// strip anything identifying from reply text before Claude sees it
const anonymise = (t) => String(t || "").replace(/[\w.+-]+@[\w.-]+/g, "[email]").replace(/(\+44|0)[\d\s]{9,13}/g, "[phone]").slice(0, 600);

export function report(data, breakdown) {
  const name = (id) => data.versions.find((v) => v.id === id)?.name || id;
  const lines = [];
  lines.push("# Aetos outreach report", "", `Generated ${new Date().toISOString().slice(0, 10)}.`, "");
  lines.push("## Rules you must follow when proposing versions",
    "- Change ONE named idea per challenger (angle, ask type, hook, or length) and state it as a hypothesis.",
    `- First email ≤ ${STEPS[0].maxWords} words; follow-ups ≤ 60; sentences ≤ 25 words; at most one question mark.`,
    "- First email: no links, no prices, no \"free\", no guarantees, a lead-specific fact in the first 2 lines.",
    "- Sound human (read it out loud), no hype, never insult their site or a competitor, never say \"SEO\" (say \"front page of Google\").",
    "- Only claim what is true today (we have their audit and Google Maps heatmap; demos are offered, not made yet).",
    `- Placeholders: {greeting} {business} {town} {trade} {problem} {top3} {competitor} {competitor_top3} {spots} {rating} {reviews} {sender_first}.`,
    "- Don't retest ideas in the past-tests log.", "");
  lines.push("## Current test");
  if (!data.test) lines.push("No test running.");
  else {
    lines.push(`Started ${data.test.started_at.slice(0, 10)}. Ends when every version has ${RULES.decideAt} counted emails or after 8 weeks.`, "");
    lines.push("| Version | Status | Sent | Counted | Positive | Rate | Expected (prior incl.) | Chance best |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const s of data.stats) {
      lines.push(`| ${name(s.id)} | ${s.status} | ${s.sends} | ${s.counted} | ${s.positive} | ${pct(s.positive, s.counted)} | ${(100 * s.mean).toFixed(1)}% | ${s.pbest === null ? "–" : `${Math.round(100 * s.pbest)}%`} |`);
    }
    for (const v of data.versions.filter((x) => x.step === 1 && x.test_id === data.test.id)) {
      lines.push("", `### ${v.name}`, `Hypothesis: ${v.hypothesis || "–"}`, "", `Subject: ${v.subject}`, "", "```", v.body, "```");
    }
  }
  const rejected = data.versions.filter((v) => v.status === "rejected");
  lines.push("", "## Rejected by the owner (he didn't want these sent; don't write like this)");
  if (!rejected.length) lines.push("None yet.");
  for (const v of rejected) lines.push(`- **${v.name}** (${v.author}): ${v.hypothesis || "–"}`, "", "```", `${v.subject ? `Subject: ${v.subject}\n\n` : ""}${v.body}`, "```");
  lines.push("", "## Past tests (don't retest these ideas)");
  if (!data.tests.length) lines.push("None yet.");
  for (const t of data.tests) lines.push(`- ${t.ended_at.slice(0, 10)}: ${t.summary}`);
  lines.push("", "## What kinds of lead reply (first emails, all time)");
  lines.push("| Group | Value | Sent | Positive | Rate |", "| --- | --- | --- | --- | --- |");
  for (const b of breakdown) lines.push(`| ${b.group} | ${b.value} | ${b.sent} | ${b.positive} | ${pct(b.positive, b.sent)} |`);
  lines.push("", "## Replies (anonymised)");
  const replies = data.replies.filter((r) => replyClass(r) && replyClass(r) !== "auto_reply" && replyClass(r) !== "bounce");
  if (!replies.length) lines.push("None yet.");
  for (const r of replies) lines.push(`- **${replyClass(r)}**: ${anonymise(r.snippet)}`);
  return lines.join("\n");
}

/** Positive replies by lead feature (top finding, maps band, trade, email source, first name known). */
export async function featureBreakdown(DB) {
  const { results } = await DB.prepare(
    `SELECT s.features, MAX(CASE WHEN r.owner_class IN ('interested', 'question') THEN 1 ELSE 0 END) AS positive
     FROM outreach_sends s LEFT JOIN outreach_replies r ON r.place_id = s.place_id
     WHERE s.step = 1 AND s.status = 'sent' GROUP BY s.id`
  ).all();
  const groups = new Map();
  for (const row of results) {
    let f = {};
    try { f = JSON.parse(row.features || "{}"); } catch { /* old rows */ }
    for (const [group, value] of Object.entries(f)) {
      const key = `${group}|${value}`;
      const g = groups.get(key) || { group, value, sent: 0, positive: 0 };
      g.sent++;
      g.positive += row.positive ? 1 : 0;
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group) || b.sent - a.sent);
}
