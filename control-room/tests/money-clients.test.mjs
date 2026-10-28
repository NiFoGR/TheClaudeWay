// Money > Add a client links the client to its lead (so the lead is marked won), even when the name is typed or pasted
// faster than the suggestions arrive: public/js/money.js resolves the lead when the form is sent (leadForClient), and
// POST /api/money/clients links an unlinked client to the one lead of exactly that name (never guessing between two).
// Run: node --test control-room/tests/money-clients.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequestPost as addClientRoute } from "../functions/api/money/clients.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedLead } from "./helpers/shortlistSeed.mjs";

// money.js reads the page when it loads (lib.js's view, its resize listener): a bare stand-in is enough to import it.
async function loadMoney() {
  const el = () => ({ innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const added = [];
  for (const [name, value] of [["document", { getElementById: el, querySelector: () => null, body: el() }], ["window", { addEventListener() {} }]]) {
    if (!Object.hasOwn(globalThis, name)) { globalThis[name] = value; added.push(name); }
  }
  try { return await import("../public/js/money.js"); } finally { for (const name of added) delete globalThis[name]; }
}
const { leadForClient, paymentsCard } = await loadMoney();

const SMITH = { place_id: "ChIJsmith", name: "Smith Roofing", town: "Leeds" };

test("leadForClient: a same-name suggestion on screen links without asking again", async () => {
  let asked = 0;
  const search = async () => { asked++; return []; };
  assert.equal(await leadForClient("smith roofing", [{ place_id: "x", name: "Smith Roofing Ltd" }, SMITH], search), SMITH);
  assert.equal(await leadForClient("  SMITH ROOFING ", [SMITH], search), SMITH, "trimmed, any case");
  assert.equal(asked, 0);
});

test("leadForClient: the name sent before the suggestions caught up is looked up then (the race)", async () => {
  // On screen: the first answer (top 50 by grade, before anything was typed), without Smith Roofing.
  const shown = Array.from({ length: 50 }, (_, i) => ({ place_id: `top${i}`, name: `Top Lead ${i}` }));
  const asked = [];
  const search = async (q) => { asked.push(q); return [{ place_id: "y", name: "Smith Roofing & Sons" }, SMITH]; };
  assert.equal(await leadForClient("Smith Roofing", shown, search), SMITH);
  assert.deepEqual(asked, ["Smith Roofing"], "one search, for exactly what's typed");
  // The search text is cut to the Leads page's 100 characters.
  await leadForClient("x".repeat(150), [], search);
  assert.equal(asked[1], "x".repeat(100));
});

test("leadForClient: never guesses, and a failed search saves the client unlinked", async () => {
  assert.equal(await leadForClient("Smith Roofing", [], async () => [{ place_id: "y", name: "Smith Roofing Ltd" }]), null,
    "a longer name isn't the same lead");
  assert.equal(await leadForClient("Smith Roofing", [], async () => { throw new Error("offline"); }), null);
  assert.equal(await leadForClient("Smith Roofing", undefined, async () => undefined), null);
  let asked = 0;
  assert.equal(await leadForClient("S", [], async () => { asked++; return [SMITH]; }), null, "under 2 characters: no search");
  assert.equal(await leadForClient("", [], async () => { asked++; return [SMITH]; }), null);
  assert.equal(asked, 0);
});

test("money.js: Add a client resolves its lead when sent, and a failed suggestion keeps the last ones", () => {
  const src = readFileSync(new URL("../public/js/money.js", import.meta.url), "utf8");
  const add = src.slice(src.indexOf("async function addClient()"), src.indexOf("function addEntry()"));
  assert.match(add, /await leadForClient\(typed\(\), leads, leadsMatching\)/, "the lead is resolved at submit");
  assert.match(add, /place_id: lead\?\.place_id \|\| ""/);
  assert.doesNotMatch(add, /place_id: match\(\)/, "not the last debounced answer");
  assert.doesNotMatch(add, /let rows = \[\];/, "a failed search doesn't wipe the suggestions");
});

// ---------------------------------------------------------------- Card payments (refunds are negative lines)

test("paymentsCard: a Stripe refund shows as −£249, not +−£249 in the money-in green", () => {
  const html = paymentsCard([
    { paid_on: "2026-10-20", name: "Smith Roofing", category: "Build fee", amount_pence: 175000, fee_pence: 2650 },
    { paid_on: "2026-10-24", name: "Smith Roofing", category: "Refunds", amount_pence: -24900, fee_pence: 0 },
  ]);
  const cells = [...html.matchAll(/<td class="r num([^"]*)">([^<]*)<\/td>/g)].map((m) => ({ cls: m[1].trim(), text: m[2] }));
  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], { cls: "amount-in", text: "+£1,750" }, "a payment stays +£ in green");
  assert.equal(cells[1].text, "−£249", "money() puts the minus in front");
  assert.doesNotMatch(cells[1].text, /\+/);
  assert.doesNotMatch(cells[1].cls, /amount-in/);
  assert.doesNotMatch(html, /\+−/);
  assert.match(html, /<h2>Card payments and refunds<\/h2>/, "the heading says refunds are in it");
  assert.match(paymentsCard([{ paid_on: "2026-10-20", name: "A", category: "Build fee", amount_pence: 175000 }]), /<h2>Card payments received<\/h2>/);
  assert.equal(paymentsCard([]), "");
});

// ---------------------------------------------------------------- POST /api/money/clients

const ORIGIN = "https://control.example";
const BODY = { name: "Smith Roofing", package: "full", build: "1950", monthly: "249", free_days: 60, paid_on: "2026-10-24" };
const post = (DB, body) => addClientRoute({
  request: new Request(`${ORIGIN}/api/money/clients`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  env: { DB },
});
const statusOf = async (DB, id) => (await DB.prepare("SELECT status FROM leads WHERE place_id = ?").bind(id).first())?.status;

test("POST /api/money/clients: no place_id → linked to the one lead of exactly that name, which is marked won", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "ChIJsmith", name: "Smith Roofing" });
  await seedLead(DB, { place_id: "ChIJother", name: "Smith Roofing Ltd" });
  const res = await post(DB, { ...BODY, name: "smith roofing", place_id: "" });
  assert.equal(res.status, 201);
  const { client } = await res.json();
  assert.equal(client.place_id, "ChIJsmith");
  assert.equal(await statusOf(DB, "ChIJsmith"), "won");
  assert.equal(await statusOf(DB, "ChIJother"), "new");
});

test("POST /api/money/clients: two leads of that name, or only an excluded one → saved unlinked, no lead touched", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "leeds", name: "Smith Roofing", town: "Leeds" });
  await seedLead(DB, { place_id: "york", name: "SMITH ROOFING", town: "York" });
  await seedLead(DB, { place_id: "chain", name: "Big Roofs", excluded: 1, exclude_reason: "Chain" });
  const two = await (await post(DB, BODY)).json();
  assert.equal(two.client.place_id, null);
  assert.deepEqual([await statusOf(DB, "leeds"), await statusOf(DB, "york")], ["new", "new"]);
  const excluded = await (await post(DB, { ...BODY, name: "Big Roofs" })).json();
  assert.equal(excluded.client.place_id, null);
  assert.equal(await statusOf(DB, "chain"), "new");
  const nobody = await (await post(DB, { ...BODY, name: "Nobody Plumbing" })).json();
  assert.equal(nobody.client.place_id, null);
});

test("POST /api/money/clients: a place_id given is used as before", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "leeds", name: "Smith Roofing" });
  await seedLead(DB, { place_id: "york", name: "Smith Roofing" });
  const { client } = await (await post(DB, { ...BODY, place_id: "york" })).json();
  assert.equal(client.place_id, "york");
  assert.deepEqual([await statusOf(DB, "leeds"), await statusOf(DB, "york")], ["new", "won"]);
});
