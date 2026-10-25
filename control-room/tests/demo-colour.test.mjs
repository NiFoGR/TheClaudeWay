// Demo brand colour: their colour if white text reads on it, else a darker shade of it, else Charcoal.
// Run: node --test control-room/tests/demo-colour.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { CHARCOAL, MIN_CONTRAST, TRADE_DEFAULT, contrastRatio, pickColour } from "../functions/_lib/demo/colour.js";

test("spec: contrast, theirs, darkened, charcoal, trade default, hostile CSS", () => {
  assert.equal(contrastRatio("#1a1c20", "#ffffff").toFixed(1), "17.1");
  assert.deepEqual(pickColour("#2E7D32", "landscaper"), { colour: "#2e7d32", source: "theirs" });
  const g = pickColour("#4caf50", "generic");
  assert.equal(g.source, "darkened");
  assert.ok(contrastRatio(g.colour, "#ffffff") >= 4.5);
  assert.deepEqual(pickColour("#a0ffff", "landscaper"), { colour: "#1a1c20", source: "charcoal" });
  assert.deepEqual(pickColour("", "landscaper"), { colour: "#2f6b3a", source: "trade" });
  assert.deepEqual(pickColour("red;}body{display:none", "generic"), { colour: "#1a1c20", source: "trade" });
});

test("constants are exactly the spec's values", () => {
  assert.equal(CHARCOAL, "#1a1c20");
  assert.equal(MIN_CONTRAST, 4.5);
  assert.deepEqual(TRADE_DEFAULT, { landscaper: "#2f6b3a", generic: "#1a1c20" });
});

test("contrastRatio is WCAG: symmetric, 21 for black on white, 1 for a colour on itself", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#4caf50", "#4caf50"), 1);
  assert.equal(contrastRatio("#1A1C20", "#FFFFFF"), contrastRatio("#1a1c20", "#ffffff"));
});

test("darkening takes the first 10% step that passes and keeps the hue (×0.7 for #4caf50)", () => {
  // ×0.9 #449e48 (3.4:1) and ×0.8 #3d8c40 (4.2:1) fail; ×0.7 #357a38 is the first to reach 4.5:1.
  assert.deepEqual(pickColour("#4caf50", "generic"), { colour: "#357a38", source: "darkened" });
  // ×0.5 is the last step: #a0ffff reaches only 4.4:1 at #508080, so Charcoal.
  assert.ok(contrastRatio("#508080", "#ffffff") < MIN_CONTRAST);
});

test("anything that isn't exactly #rrggbb counts as no colour", () => {
  for (const bad of [null, undefined, 42, {}, ["#2e7d32"], "#fff", "2e7d32", "#2e7d32 ", " #2e7d32", "#2e7d3g",
    "#2e7d32;}body{display:none", "#2e7d32\n", "red", "rgb(46,125,50)", "#2e7d32</style><script>alert(1)</script>"]) {
    assert.deepEqual(pickColour(bad, "landscaper"), { colour: "#2f6b3a", source: "trade" }, String(bad));
    assert.deepEqual(pickColour(bad, "generic"), { colour: "#1a1c20", source: "trade" }, String(bad));
  }
});

test("an unknown template falls back to the generic default", () => {
  assert.deepEqual(pickColour("", "plumber"), { colour: "#1a1c20", source: "trade" });
  assert.deepEqual(pickColour("", undefined), { colour: "#1a1c20", source: "trade" });
  // Names every object inherits must not pull a function or object into the page's CSS.
  for (const t of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.deepEqual(pickColour("", t), { colour: "#1a1c20", source: "trade" }, t);
  }
});

test("4.5:1 is inclusive: #767676 (4.54:1) is kept, #777777 (4.48:1) is darkened to #6b6b6b", () => {
  assert.equal(contrastRatio("#767676", "#ffffff").toFixed(2), "4.54");
  assert.equal(contrastRatio("#777777", "#ffffff").toFixed(2), "4.48");
  assert.deepEqual(pickColour("#767676", "generic"), { colour: "#767676", source: "theirs" });
  assert.deepEqual(pickColour("#777777", "generic"), { colour: "#6b6b6b", source: "darkened" });
  // Upper-case input darkens to the same lower-case shade.
  assert.deepEqual(pickColour("#4CAF50", "landscaper"), { colour: "#357a38", source: "darkened" });
  // White can't be darkened far enough within 50% (#808080 is 3.9:1), so Charcoal.
  assert.deepEqual(pickColour("#ffffff", "landscaper"), { colour: "#1a1c20", source: "charcoal" });
});

test("contrastRatio refuses anything that isn't #rrggbb instead of returning a made-up number", () => {
  for (const bad of ["red", "#fff", "", null, undefined, "#2e7d32ff", "#2e7d32;"]) {
    assert.throws(() => contrastRatio(bad, "#ffffff"), TypeError, String(bad));
    assert.throws(() => contrastRatio("#ffffff", bad), TypeError, String(bad));
  }
  assert.deepEqual(pickColour("#2e7d32ff", "landscaper"), { colour: "#2f6b3a", source: "trade" });
});

test("every colour returned is lower-case #rrggbb and readable with white text", () => {
  for (const c of ["#2E7D32", "#4CAF50", "#A0FFFF", "#FFFFFF", "#000000", "#ffc93c", "#1e4f86", "", "nope"]) {
    for (const t of ["landscaper", "generic"]) {
      const { colour } = pickColour(c, t);
      assert.match(colour, /^#[0-9a-f]{6}$/);
      assert.ok(contrastRatio(colour, "#ffffff") >= MIN_CONTRAST, `${c} ${t} → ${colour}`);
    }
  }
});
