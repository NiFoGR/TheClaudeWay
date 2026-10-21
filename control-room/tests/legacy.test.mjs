import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Run from the repo root, so paths are relative to it.
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("no new code imports legacy/", () => {
  const files = walk("control-room/functions").concat(walk("control-room/public/js")).filter(f => /\.m?js$/.test(f));
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /from\s+["'][^"']*legacy\//, f);
  assert.ok(existsSync("legacy/README.md"));
  assert.match(readFileSync("legacy/README.md", "utf8"), /not deployed, kept for reference/);
});
