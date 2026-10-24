// The grade rubric (pure, no imports): Claude scores four points, each a whole number 0-5, and the server turns them
// into a grade from A+ to D here. Claude never sends a grade or a total. Rules are docs/rebuild/03-research-grade.md
// ("The grade rubric"); a test pins every boundary.
//
// Owned by stage 2. Later stages only read it (shortlist filters, re-grading stored rows); none re-creates it.

const KEYS = ["need", "means", "reach", "fit"];

// First match wins.
const RULES = [
  { grade: "A+", total: 17, reach: 4 },
  { grade: "A", total: 14, reach: 3 },
  { grade: "B", total: 11, reach: 0 },
  { grade: "C", total: 8, reach: 0 },
];

const RANK = { "A+": 4, A: 3, B: 2, C: 1, D: 0 };

/**
 * Four points to a grade.
 * `points` is `{need, means, reach, fit}` (extra keys such as a stored row's total/capped/reasons are ignored);
 * `tooBig` is Claude's "too big for us" flag (true/false, or 0/1 straight from D1).
 * Returns `{grade, total, capped}`: `capped` names the cap that lowered the grade ("too_big", then "fit", then
 * "reach" in that order of precedence), or null when no cap changed it.
 * Throws TypeError("points.<key> must be a whole number from 0 to 5") for a missing, non-integer or out-of-range point.
 */
export function gradeFrom(points, tooBig = false) {
  const p = {};
  let total = 0;
  for (const key of KEYS) {
    const value = points == null ? undefined : points[key];
    if (!Number.isInteger(value) || value < 0 || value > 5) {
      throw new TypeError(`points.${key} must be a whole number from 0 to 5`);
    }
    p[key] = value;
    total += value;
  }

  const base = RULES.find((r) => total >= r.total && p.reach >= r.reach)?.grade || "D";

  // Caps, highest precedence first: too_big and fit drop the grade to D; reach <= 1 holds it at C at most.
  const caps = [
    { name: "too_big", applies: Boolean(tooBig), max: "D" },
    { name: "fit", applies: p.fit <= 1, max: "D" },
    { name: "reach", applies: p.reach <= 1, max: "C" },
  ];
  let grade = base;
  for (const cap of caps) {
    if (cap.applies && RANK[cap.max] < RANK[grade]) grade = cap.max;
  }
  const capped = caps.find((cap) => cap.applies && RANK[cap.max] < RANK[base])?.name || null;

  return { grade, total, capped };
}
