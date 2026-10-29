// The 7-day guarantee clock (pure). The clock is absolute: due = submitted + 168 hours, whatever the UK clocks do in
// between. Labels show UK days (ukTime.js). Levels use the same words as the health lights.

import { ukParts } from "../ukTime.js";

const HOUR_MS = 3600000;
const DUE_HOURS = 168;
const RED_HOURS = 48;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toMs(value, what) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`The ${what} isn't a valid date: ${JSON.stringify(String(value))}`);
  return ms;
}

// ISO without the ".000" when there are no milliseconds: "2026-10-31T22:30:00Z".
const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

const daysWord = (n) => `${n} ${n === 1 ? "day" : "days"}`;

// Whole days late, at least 1: any time past the due moment breaks the guarantee.
const daysLate = (hoursLate) => Math.max(1, Math.floor(hoursLate / 24));

/** The due-live moment: `submittedAtIso` + 168 h exactly. */
export function dueFrom(submittedAtIso) {
  return iso(toMs(submittedAtIso, "submitted date") + DUE_HOURS * HOUR_MS);
}

/** The UK day of `isoStr`, e.g. "Sat 31 Oct". */
export function ukShortDay(isoStr) {
  const { d, m, weekday } = ukParts(new Date(toMs(isoStr, "date")));
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * The countdown for a site due live at `dueIso`. Before live (`liveIso` null): "Due live Sat 31 Oct · 6 days left"
 * (grey; red under 48 h), then "2 days late" (red) once past due. After live: "Live Fri 30 Oct · on time" (green) or
 * "Live Sun 1 Nov · 1 day late" (amber). hoursLeft is due − now before live, due − live after (negative = late).
 */
export function countdown(dueIso, liveIso, now = new Date()) {
  const dueMs = toMs(dueIso, "due date");
  if (liveIso) {
    const liveMs = toMs(liveIso, "live date");
    const hoursLeft = (dueMs - liveMs) / HOUR_MS;
    const day = ukShortDay(liveIso);
    if (hoursLeft >= 0) return { label: `Live ${day} · on time`, level: "green", hoursLeft };
    return { label: `Live ${day} · ${daysWord(daysLate(-hoursLeft))} late`, level: "amber", hoursLeft };
  }
  const hoursLeft = (dueMs - toMs(now, "current time")) / HOUR_MS;
  if (hoursLeft < 0) return { label: `${daysWord(daysLate(-hoursLeft))} late`, level: "red", hoursLeft };
  const left = hoursLeft < 24 ? "less than a day left" : `${daysWord(Math.floor(hoursLeft / 24))} left`;
  return { label: `Due live ${ukShortDay(dueIso)} · ${left}`, level: hoursLeft < RED_HOURS ? "red" : "grey", hoursLeft };
}
