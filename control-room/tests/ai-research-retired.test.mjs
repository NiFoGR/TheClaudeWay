// Stage 2 retired leads.audit.ai_research: Claude's research lives only in the research table, and nothing writes the
// old field any more. Code still reading it gives false numbers for ever (a lead whose research found an email shown
// as "No email found", an ORDER BY that does nothing). Comments may still name it. Run:
// node --test control-room/tests/ai-research-retired.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

// Block comments, then line comments ("//" not after a ":" so a URL like https://… stays code).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("no Control Room code reads leads.audit.ai_research (the research table replaced it)", () => {
  const files = walk(join(ROOT, "functions")).concat(walk(join(ROOT, "public/js")));
  assert.ok(files.length > 20, "found the Control Room's code");
  const readers = files.filter((f) => /ai_research/.test(code(readFileSync(f, "utf8")))).map((f) => f.slice(ROOT.length));
  assert.deepEqual(readers, []);
});
