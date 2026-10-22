// Deploying the relay (Part B Task 19): precheck.sh says, in plain English, what to fix before the deploy runs, and
// deploy-relay.yml fills in wrangler.toml and deploys. Run: node --test mail-relay/tests/precheck.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/precheck.sh", import.meta.url));
const file = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const TOKEN = "cf-test-token-q7Xv2mN9pL4sR8tW";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const D1_ID = "5d6c7b8a-1e2f-4a3b-9c8d-0e1f2a3b4c5d";
const TOKEN_FIX = "Your Cloudflare API token can't deploy Workers. Fix: Cloudflare → My Profile → API Tokens → edit the token GitHub uses → add Account · Workers Scripts · Edit, and Zone · Email Routing Rules · Edit → Save. Then re-run this workflow.";
const APP_URL_FIX = "Add a repository variable CONTROL_ROOM_URL (e.g. https://control.aetoswebsites.com): GitHub → Settings → Secrets and variables → Actions → Variables.";
const A4 = "Set the routing rule by hand: Setup → Receiving replies, step A4";

// Cloudflare's real answers (probed live) for a token it doesn't accept at all, by route. A well-formed but wrong
// token: 401 on /workers/scripts, but 403 on /zones. A malformed one (a space, cut short): 400 on both.
const WRONG_TOKEN = {
  scripts: [401, [{ code: 10000, message: "Authentication error" }]],
  zones: [403, [{ code: 9109, message: "Invalid access token" }]],
};
const MALFORMED_TOKEN = {
  scripts: [400, [{ code: 9106, message: "Authentication failed (status: 400)" }]],
  zones: [400, [{ code: 6003, message: "Invalid request headers", error_chain: [{ code: 6111, message: "Invalid format for Authorization header" }] }]],
};

// A fake Cloudflare API on 127.0.0.1. `status` maps a route (scripts, zones, rules) to the HTTP status it answers
// (default 200), or to [status, errors] for a given error body. Every request is recorded with its Authorization header.
async function fakeCloudflare(t, status = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization });
    let route;
    let result = [];
    if (url.pathname === `/client/v4/accounts/${ACCOUNT}/workers/scripts`) route = "scripts";
    else if (url.pathname === "/client/v4/zones") {
      route = "zones";
      if (url.searchParams.get("name") === "r.co.uk") result = [{ id: ZONE, name: "r.co.uk", account: { id: ACCOUNT } }];
    } else if (url.pathname === `/client/v4/zones/${ZONE}/email/routing/rules`) route = "rules";
    const answer = route ? status[route] ?? 200 : 404;
    const [code, errors] = Array.isArray(answer) ? answer : [answer, [{ code: 10000, message: "Authentication error" }]];
    const body = code < 300
      ? { success: true, errors: [], messages: [], result }
      : { success: false, errors, messages: [], result: null };
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}/client/v4`, requests };
}

// Runs `bash precheck.sh` with only the given environment (plus PATH). The token must never be printed.
function precheck(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], { env: { PATH: process.env.PATH, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), "the API token is never printed");
      resolve({ code, stdout, stderr });
    });
  });
}

const baseEnv = (api, extra = {}) => ({
  CF_API: api,
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  D1_DATABASE_ID: D1_ID,
  APP_URL: "https://control.aetoswebsites.com",
  ...extra,
});

// ---------------------------------------------------------------- precheck.sh

test("a 403 on the Workers scripts list exits 1 with the token fix", async (t) => {
  const cf = await fakeCloudflare(t, { scripts: 403 });
  const run = await precheck(baseEnv(cf.api));
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.ok(run.stdout.includes(TOKEN_FIX), run.stdout);
  assert.deepEqual(cf.requests.map((r) => [r.method, r.path]), [["GET", `/client/v4/accounts/${ACCOUNT}/workers/scripts`]]);
  assert.equal(cf.requests[0].auth, `Bearer ${TOKEN}`);
});

test("an empty APP_URL exits 1 with how to add CONTROL_ROOM_URL", async (t) => {
  const cf = await fakeCloudflare(t);
  for (const APP_URL of ["", undefined]) {
    const env = baseEnv(cf.api, { APP_URL });
    if (APP_URL === undefined) delete env.APP_URL;
    const run = await precheck(env);
    assert.equal(run.code, 1, `APP_URL = ${JSON.stringify(APP_URL)}: ${run.stdout}${run.stderr}`);
    assert.ok(run.stdout.includes(APP_URL_FIX), run.stdout);
    assert.ok(!run.stdout.includes(TOKEN_FIX), "the token itself is fine");
  }
});

test("with all 200s it exits 0", async (t) => {
  const cf = await fakeCloudflare(t);
  const run = await precheck(baseEnv(cf.api));
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /Fix:|Add a repository/);
  // Without INBOUND_ADDRESS only the Workers check runs.
  assert.deepEqual(cf.requests.map((r) => r.path), [`/client/v4/accounts/${ACCOUNT}/workers/scripts`]);
});

test("with INBOUND_ADDRESS set and the email routing rules call returning 403, it exits 1 with the same fix", async (t) => {
  const cf = await fakeCloudflare(t, { rules: 403 });
  const run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.ok(run.stdout.includes(TOKEN_FIX), run.stdout);
  assert.equal(run.stdout.split(TOKEN_FIX).length, 2, "the fix is printed once");
  assert.deepEqual(cf.requests.map((r) => r.path + r.search), [
    `/client/v4/accounts/${ACCOUNT}/workers/scripts`,
    "/client/v4/zones?name=r.co.uk",
    `/client/v4/zones/${ZONE}/email/routing/rules`,
  ]);
  for (const r of cf.requests) assert.equal(r.auth, `Bearer ${TOKEN}`);
});

test("with INBOUND_ADDRESS set and all 200s it checks the zone and its routing rules, then exits 0", async (t) => {
  const cf = await fakeCloudflare(t);
  const run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "Replies@R.co.uk" }));
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.deepEqual(cf.requests.map((r) => r.path + r.search), [
    `/client/v4/accounts/${ACCOUNT}/workers/scripts`,
    "/client/v4/zones?name=r.co.uk",
    `/client/v4/zones/${ZONE}/email/routing/rules`,
  ]);
});

// Listing zones needs Zone · Zone · Read (Cloudflare's API schema), which the token fix doesn't ask for and the deploy
// doesn't need, so a lookup the token isn't allowed must not block the deploy (adding the two permissions again
// wouldn't fix it). Nor does a domain Cloudflare doesn't have: the deploy tries the rule and falls back to step A4.
const NO_LOOKUP = "Couldn't look up";

test("a zone lookup the token isn't allowed, or a domain Cloudflare doesn't have, doesn't block the deploy", async (t) => {
  const denied = await fakeCloudflare(t, { zones: [403, [{ code: 9109, message: "Unauthorized to access requested resource" }]] });
  let run = await precheck(baseEnv(denied.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 0, run.stdout);
  assert.ok(run.stdout.includes(`${NO_LOOKUP} r.co.uk, the domain in INBOUND_ADDRESS`), run.stdout);
  assert.match(run.stdout, /Zone · Zone · Read/);
  assert.ok(!run.stdout.includes(TOKEN_FIX), "adding the two permissions again wouldn't fix this");
  assert.ok(!denied.requests.some((r) => r.path.includes("/email/routing/rules")), "no rules call without a zone");

  const cf = await fakeCloudflare(t);
  run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "replies@not-on-cloudflare.co.uk", GITHUB_ACTIONS: "true" }));
  assert.equal(run.code, 0, run.stdout);
  assert.ok(run.stdout.includes(`::warning::${NO_LOOKUP} not-on-cloudflare.co.uk, the domain in INBOUND_ADDRESS`), run.stdout);
  assert.match(run.stdout, /steps A1 to A3/);
  assert.ok(!cf.requests.some((r) => r.path.includes("/email/routing/rules")), "no rules call without a zone");
});

test("a zone lookup that fails for any other reason still stops the deploy", async (t) => {
  const busy = await fakeCloudflare(t, { zones: [503, [{ code: 10001, message: "Service unavailable" }]] });
  let run = await precheck(baseEnv(busy.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Cloudflare's API isn't working right now \(HTTP 503\)/);
  assert.ok(!run.stdout.includes(NO_LOOKUP));

  const limited = await fakeCloudflare(t, { zones: [429, [{ code: 10429, message: "Rate limited" }]] });
  run = await precheck(baseEnv(limited.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Cloudflare answered HTTP 429 \(Rate limited\)\. Wait a minute, then re-run this workflow\./);
});

test("missing secrets and bad values are named, with where to fix them, and nothing is called without a token", async (t) => {
  const cf = await fakeCloudflare(t);
  const run = await precheck(baseEnv(cf.api, {
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    D1_DATABASE_ID: "",
    APP_URL: "http://control.aetoswebsites.com/api",
    INBOUND_ADDRESS: "replies at r.co.uk",
    FORWARD_COPY_TO: 'nik@gmail.com"',
  }));
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Add the repository secret CLOUDFLARE_API_TOKEN/);
  assert.match(run.stdout, /Add the repository secret CLOUDFLARE_ACCOUNT_ID/);
  assert.match(run.stdout, /Add the repository secret D1_DATABASE_ID/);
  assert.match(run.stdout, /CONTROL_ROOM_URL must be just the Control Room's address, starting with https:\/\//);
  assert.match(run.stdout, /INBOUND_ADDRESS isn't an email address/);
  assert.match(run.stdout, /FORWARD_COPY_TO isn't an email address/);
  assert.deepEqual(cf.requests, []);
});

test("a Cloudflare API that can't be reached exits 1 with a plain message", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const run = await precheck(baseEnv(`http://127.0.0.1:${port}/client/v4`, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Couldn't reach Cloudflare's API/);
  assert.equal(run.stdout.split("Couldn't reach Cloudflare's API").length, 2, "said once");
});

test("in GitHub Actions each problem is an error annotation", async (t) => {
  const cf = await fakeCloudflare(t, { scripts: 403 });
  const run = await precheck(baseEnv(cf.api, { GITHUB_ACTIONS: "true" }));
  assert.equal(run.code, 1);
  assert.ok(run.stdout.includes(`::error::${TOKEN_FIX}`), run.stdout);
});

const BAD_TOKEN = "Cloudflare didn't accept the API token GitHub uses at all";

test("a wrong token says so once, and never asks for permissions (Cloudflare answers 401 here but 403 on /zones)", async (t) => {
  const cf = await fakeCloudflare(t, WRONG_TOKEN);
  const run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.equal(run.stdout.split(BAD_TOKEN).length, 2, run.stdout);
  assert.ok(!run.stdout.includes(TOKEN_FIX), "adding permissions won't fix a wrong token");
  assert.doesNotMatch(run.stdout, /HTTP 403|Check INBOUND_ADDRESS/);
});

test("a malformed token (HTTP 400 from Cloudflare) is a token problem, not an account id or address problem", async (t) => {
  const cf = await fakeCloudflare(t, MALFORMED_TOKEN);
  const run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.equal(run.stdout.split(BAD_TOKEN).length, 2, run.stdout);
  assert.doesNotMatch(run.stdout, /Check CLOUDFLARE_ACCOUNT_ID|Check INBOUND_ADDRESS|HTTP 400/);
  assert.ok(!run.stdout.includes(TOKEN_FIX));
});

test("a 403 that isn't about the token being invalid gets the permissions fix", async (t) => {
  const cf = await fakeCloudflare(t, { rules: [403, [{ code: 9109, message: "Unauthorized to access requested resource" }]] });
  const run = await precheck(baseEnv(cf.api, { INBOUND_ADDRESS: "replies@r.co.uk" }));
  assert.equal(run.code, 1);
  assert.ok(run.stdout.includes(TOKEN_FIX), run.stdout);
  assert.ok(!run.stdout.includes(BAD_TOKEN));
});

test("an Account ID or Database ID in the wrong shape is caught before calling Cloudflare", async (t) => {
  const cf = await fakeCloudflare(t);
  const run = await precheck(baseEnv(cf.api, { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef", D1_DATABASE_ID: "goldbarwebsites" }));
  assert.equal(run.code, 1);
  assert.match(run.stdout, /CLOUDFLARE_ACCOUNT_ID must be just the Account ID/);
  assert.match(run.stdout, /D1_DATABASE_ID must be just the Database ID of goldbarwebsites/);
  assert.deepEqual(cf.requests, [], "no Workers call with a bad Account ID");
});

test("PRECHECK_REPORT gets each problem as plain text, one per line, and is emptied on a clean run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-precheck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, "problems.txt");
  const denied = await fakeCloudflare(t, { scripts: 403 });
  let run = await precheck(baseEnv(denied.api, { APP_URL: "", GITHUB_ACTIONS: "true", PRECHECK_REPORT: report }));
  assert.equal(run.code, 1);
  assert.deepEqual(readFileSync(report, "utf8").split("\n"), [APP_URL_FIX, TOKEN_FIX, ""]);

  const cf = await fakeCloudflare(t);
  run = await precheck(baseEnv(cf.api, { PRECHECK_REPORT: report }));
  assert.equal(run.code, 0, run.stdout);
  assert.equal(readFileSync(report, "utf8"), "");
});

// ---------------------------------------------------------------- deploy-relay.yml

// The shell of every `run:` (one-liners, and the lines of `run: |` blocks).
function runScripts(yaml) {
  const lines = yaml.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!m) continue;
    if (!/^[|>]/.test(m[3])) {
      out.push(m[3]);
      continue;
    }
    const indent = m[1].length + (m[2] ? 2 : 0);
    while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > indent)) out.push(lines[++i]);
  }
  return out;
}

// The shell of the step called `name`.
function stepScript(yaml, name) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `no step named "${name}"`);
  const dash = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && lines[end].search(/\S/) <= dash)) end++;
  return runScripts(lines.slice(start, end).join("\n")).join("\n");
}

function bash(script, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-e", "-c", script], { cwd, env: { PATH: process.env.PATH, ...env } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("deploy-relay.yml: triggers, steps in order, the pinned wrangler, and the A4 fallback", () => {
  const yaml = file(".github/workflows/deploy-relay.yml");
  assert.match(yaml, /^name: Deploy mail relay$/m);
  assert.match(yaml, /branches: \[claude\/confident-hawking-vi0lgk\]/);
  assert.match(yaml, /- "mail-relay\/\*\*"/);
  assert.match(yaml, /- "\.github\/workflows\/deploy-relay\.yml"/);
  assert.match(yaml, /^\s+workflow_dispatch:/m);
  assert.match(yaml, /node-version: "22"/);
  assert.match(yaml, /APP_URL: \$\{\{ vars\.CONTROL_ROOM_URL \|\| secrets\.CONTROL_ROOM_URL \}\}/);
  for (const name of ["INBOUND_ADDRESS", "FORWARD_COPY_TO"]) {
    assert.ok(yaml.includes(`${name}: \${{ vars.${name} || secrets.${name} }}`), name);
  }
  const order = [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "node --test mail-relay/tests/*.test.mjs",
    "bash mail-relay/scripts/precheck.sh",
    "__D1_DATABASE_ID__",
    "addresses = [",
    "cloudflare/wrangler-action@v4",
  ].map((s) => [s, yaml.indexOf(s)]);
  for (const [s, at] of order) assert.ok(at >= 0, `missing ${s}`);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} before ${order[i][0]}`);

  assert.equal(yaml.split("uses: cloudflare/wrangler-action@v4").length - 1, 2, "a deploy, and a retry without addresses");
  // 4.112.0 accepts `addresses` but sets no routing rule (checked in its published code); 4.113.0 is the first that does.
  assert.equal(yaml.split('wranglerVersion: "4.113.0"').length - 1, 2);
  assert.ok(!yaml.includes('wranglerVersion: "4.112.0"'), "4.112.0 would deploy green without setting the rule");
  assert.equal(yaml.split("workingDirectory: mail-relay").length - 1, 2);
  assert.equal(yaml.split("command: deploy").length - 1, 2);
  assert.equal(yaml.split("apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}").length - 1, 2);
  assert.equal(yaml.split("accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}").length - 1, 2);
  assert.match(yaml, /continue-on-error: \$\{\{ env\.INBOUND_ADDRESS != '' \}\}/);
  assert.ok(yaml.includes(A4), "prints how to set the routing rule by hand");
  assert.ok(yaml.includes(TOKEN_FIX), "a failed deploy also says how to fix the token");

  // Each step's own lines, by name.
  const step = (name) => {
    const lines = yaml.split("\n");
    const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    assert.ok(start >= 0, `no step named "${name}"`);
    const dash = lines[start].indexOf("-");
    let end = start + 1;
    while (end < lines.length && !(lines[end].trim() && lines[end].search(/\S/) <= dash)) end++;
    return lines.slice(start, end).join("\n");
  };
  assert.match(step("Add the reply address"), /\n\s+if: env\.INBOUND_ADDRESS != ''\n/);
  assert.match(step("Deploy"), /\n\s+id: deploy\n/);
  // Only a failed deploy *with* `addresses` is allowed to fail: without INBOUND_ADDRESS a failed deploy is a red run.
  assert.equal(yaml.split("continue-on-error:").length - 1, 1, "the retry has no continue-on-error");
  for (const name of ["Drop the reply address", "Deploy without the reply address", "Say how to set the routing rule"]) {
    assert.match(step(name), /\n\s+if: steps\.deploy\.outcome == 'failure'\n/, name);
  }
  assert.ok(step("Say how to set the routing rule").includes(A4));
  assert.match(step("What to fix"), /\n\s+if: failure\(\)\n/);
  assert.ok(yaml.trimEnd().endsWith(step("What to fix").trimEnd()), "What to fix is the last step");
});

test("deploy-relay.yml never puts ${{ }} into a shell script (values go through env)", () => {
  const scripts = runScripts(file(".github/workflows/deploy-relay.yml"));
  assert.ok(scripts.length >= 5, "found the run steps");
  for (const line of scripts) assert.ok(!line.includes("${{"), line);
});

test("deploy-relay.yml fills in wrangler.toml, adds the reply address first, and drops it for the retry", async (t) => {
  const yaml = file(".github/workflows/deploy-relay.yml");
  const toml = file("mail-relay/wrangler.toml");
  for (const placeholder of ["__APP_URL__", "__D1_DATABASE_ID__", "__FORWARD_COPY_TO__"]) {
    assert.ok(toml.includes(`"${placeholder}"`), `wrangler.toml has ${placeholder}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "relay-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "mail-relay"));
  const path = join(dir, "mail-relay", "wrangler.toml");
  const read = () => readFileSync(path, "utf8");

  for (const copyTo of ["nik+relay@gmail.com", ""]) {
    writeFileSync(path, toml);
    const env = { APP_URL: "https://aetos-control.pages.dev", D1_DATABASE_ID: D1_ID, FORWARD_COPY_TO: copyTo, RUNNER_TEMP: dir };
    let run = await bash(stepScript(yaml, "Fill in wrangler.toml"), dir, env);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(read(), /"__[A-Z0-9_]+__"/, "every placeholder is filled in");
    assert.match(read(), /^APP_URL = "https:\/\/aetos-control\.pages\.dev"$/m);
    assert.ok(read().includes(`database_id = "${D1_ID}"`));
    assert.ok(read().includes(`FORWARD_COPY_TO = "${copyTo}"`));
    assert.ok(read().startsWith('name = "aetos-mail-relay"\n'));

    run = await bash(stepScript(yaml, "Add the reply address"), dir, { ...env, INBOUND_ADDRESS: "replies@r.co.uk" });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(read().startsWith('addresses = ["replies@r.co.uk"]\nname = "aetos-mail-relay"\n'), read().slice(0, 80));

    run = await bash(stepScript(yaml, "Drop the reply address"), dir, env);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(read().startsWith('name = "aetos-mail-relay"\n'));
    assert.doesNotMatch(read(), /addresses/);
  }
});

function bashOut(script, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-e", "-c", script], { cwd, env: { PATH: process.env.PATH, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("deploy-relay.yml's last step repeats the precheck's problems, so the run's last step says what to fix", async (t) => {
  const yaml = file(".github/workflows/deploy-relay.yml");
  assert.match(yaml, /PRECHECK_REPORT: \$\{\{ runner\.temp \}\}\/precheck-problems\.txt\n\s+run: bash mail-relay\/scripts\/precheck\.sh/);
  const dir = mkdtempSync(join(tmpdir(), "relay-fix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, "precheck-problems.txt");
  const summary = join(dir, "summary.md");
  const script = stepScript(yaml, "What to fix");
  const run = (env) => {
    writeFileSync(summary, "");
    return bashOut(script, dir, { GITHUB_STEP_SUMMARY: summary, PRECHECK_REPORT: report, ...env });
  };

  // The precheck already made each problem an annotation, so they're repeated as plain lines, then one error.
  writeFileSync(report, `${APP_URL_FIX}\nCloudflare answered HTTP 418 (100% teapot).\n`);
  let out = await run({ TESTS: "success", PRECHECK: "failure", DEPLOY: "skipped", RETRY: "skipped" });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n"), [
    `- ${APP_URL_FIX}`,
    "- Cloudflare answered HTTP 418 (100% teapot).",
    "::error::Nothing was deployed. Fix what's listed above, then re-run this workflow: GitHub → Actions → Deploy mail relay → Run workflow.",
  ]);
  assert.ok(readFileSync(summary, "utf8").includes(`- ${APP_URL_FIX}\n`));

  // A failed deploy (no INBOUND_ADDRESS), or a failed retry after the deploy with `addresses` failed.
  for (const [DEPLOY, RETRY] of [["failure", "skipped"], ["failure", "failure"]]) {
    out = await run({ TESTS: "success", PRECHECK: "success", DEPLOY, RETRY });
    assert.ok(out.stdout.includes(TOKEN_FIX), `${DEPLOY}/${RETRY}: a failed deploy repeats the token fix`);
    assert.match(out.stdout, /^::error::The deploy to Cloudflare failed/);
  }
  // The deploy with `addresses` failed but the retry worked: something later failed, not the deploy.
  out = await run({ TESTS: "success", PRECHECK: "success", DEPLOY: "failure", RETRY: "success" });
  assert.match(out.stdout, /^::error::Something else went wrong/);
  out = await run({ TESTS: "failure", PRECHECK: "skipped", DEPLOY: "skipped", RETRY: "skipped" });
  assert.match(out.stdout, /^::error::The relay's tests failed, so nothing was deployed\./);
  // A precheck that failed without writing its report points at its own step.
  writeFileSync(report, "");
  out = await run({ TESTS: "success", PRECHECK: "failure", DEPLOY: "skipped", RETRY: "skipped" });
  assert.match(out.stdout, /^::error::Nothing was deployed\. The step "Check the Cloudflare token and settings" says what to fix\./);
});

test("deploy-relay.yml's fallback step prints the A4 line and explains it", async (t) => {
  const yaml = file(".github/workflows/deploy-relay.yml");
  const dir = mkdtempSync(join(tmpdir(), "relay-a4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const out = await bashOut(stepScript(yaml, "Say how to set the routing rule"), dir, { GITHUB_STEP_SUMMARY: summary, INBOUND_ADDRESS: "replies@r.co.uk" });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, `::warning::${A4}\n`);
  const text = readFileSync(summary, "utf8");
  assert.ok(text.startsWith(`${A4}\n`), text);
  assert.match(text, /couldn't set the email routing rule for replies@r\.co\.uk/);
});
