// The grade rubric: four points (need, means, reach, fit, each 0-5) to a grade A+ to D, with the caps and their
// precedence. Claude never sends a grade; the server always computes it here.
// Run: node --test control-room/tests/grade.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { gradeFrom } from "../functions/_lib/grade.js";

const cases = [ // [need, means, reach, fit, tooBig, grade, total, capped]
  [5,5,5,5,false,"A+",20,null], [5,4,4,4,false,"A+",17,null], [5,5,3,4,false,"A",17,null],
  [4,4,4,4,false,"A",16,null], [4,4,3,3,false,"A",14,null], [4,3,3,3,false,"B",13,null],
  [5,5,2,5,false,"B",17,null], [3,3,2,3,false,"B",11,null], [3,2,2,3,false,"C",10,null],
  [2,2,2,2,false,"C",8,null], [2,2,1,2,false,"D",7,null], [2,2,1,3,false,"C",8,null],
  [5,5,1,5,false,"C",16,"reach"], [5,5,0,5,false,"C",15,"reach"], [5,5,5,1,false,"D",16,"fit"],
  [5,5,5,0,false,"D",15,"fit"], [5,5,5,5,true,"D",20,"too_big"], [4,4,1,0,false,"D",9,"fit"],
  [5,5,0,1,true,"D",11,"too_big"], [0,0,0,0,false,"D",0,null],
];

for (const [need, means, reach, fit, tooBig, grade, total, capped] of cases) {
  test(`gradeFrom: need ${need}, means ${means}, reach ${reach}, fit ${fit}${tooBig ? ", too big" : ""} -> ${grade} (${total}${capped ? `, capped by ${capped}` : ""})`, () => {
    assert.deepEqual(gradeFrom({ need, means, reach, fit }, tooBig), { grade, total, capped });
  });
}

// Beyond the spec's table: fit 2 never caps (even at A+); when fit and reach would both lower the grade, fit wins;
// a cap on a lead that is D anyway lowers nothing, so capped stays null (the card's "Too big for us" tag reads too_big).
const more = [ // [need, means, reach, fit, tooBig, grade, total, capped]
  [5,5,5,2,false,"A+",17,null], [5,5,1,1,false,"D",12,"fit"], [5,5,0,5,true,"D",15,"too_big"],
  [1,1,1,1,true,"D",4,null], [2,2,2,1,false,"D",7,null],
];

for (const [need, means, reach, fit, tooBig, grade, total, capped] of more) {
  test(`gradeFrom (extra): need ${need}, means ${means}, reach ${reach}, fit ${fit}${tooBig ? ", too big" : ""} -> ${grade} (${total}${capped ? `, capped by ${capped}` : ""})`, () => {
    assert.deepEqual(gradeFrom({ need, means, reach, fit }, tooBig), { grade, total, capped });
  });
}

test("gradeFrom: points.need above 5 is rejected", () => {
  assert.throws(() => gradeFrom({ need: 6, means: 0, reach: 0, fit: 0 }),
    /points.need must be a whole number from 0 to 5/);
});

test("gradeFrom: a fraction is rejected", () => {
  assert.throws(() => gradeFrom({ need: 2.5, means: 0, reach: 0, fit: 0 }),
    /points.need must be a whole number from 0 to 5/);
});

test("gradeFrom: a number written as a string is rejected", () => {
  assert.throws(() => gradeFrom({ need: "3", means: 0, reach: 0, fit: 0 }),
    /points.need must be a whole number from 0 to 5/);
});

test("gradeFrom: a missing point is rejected", () => {
  assert.throws(() => gradeFrom({ need: 3, means: 3, reach: 3 }),
    /points.fit must be a whole number from 0 to 5/);
});

test("gradeFrom: the error is a TypeError with the exact message", () => {
  assert.throws(() => gradeFrom({ need: 1, means: -1, reach: 0, fit: 0 }),
    (err) => err instanceof TypeError && err.message === "points.means must be a whole number from 0 to 5");
  assert.throws(() => gradeFrom({ need: 1, means: 1, reach: null, fit: 0 }),
    (err) => err instanceof TypeError && err.message === "points.reach must be a whole number from 0 to 5");
  assert.throws(() => gradeFrom({ need: Number.NaN, means: 1, reach: 1, fit: 0 }),
    (err) => err instanceof TypeError && err.message === "points.need must be a whole number from 0 to 5");
  assert.throws(() => gradeFrom(null),
    (err) => err instanceof TypeError && err.message === "points.need must be a whole number from 0 to 5");
});

test("gradeFrom: tooBig defaults to false", () => {
  assert.deepEqual(gradeFrom({ need: 5, means: 5, reach: 5, fit: 5 }), { grade: "A+", total: 20, capped: null });
});

test("gradeFrom: a stored row regrades the same (extra keys in points, too_big as 0/1 from D1)", () => {
  const stored = { need: 5, means: 4, reach: 4, fit: 4, total: 17, capped: null,
    reasons: { need: "n", means: "m", reach: "r", fit: "f" } };
  assert.deepEqual(gradeFrom(stored, 0), { grade: "A+", total: 17, capped: null });
  assert.deepEqual(gradeFrom(stored, 1), { grade: "D", total: 17, capped: "too_big" });
});
