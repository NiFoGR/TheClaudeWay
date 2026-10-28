// The nav and the one route list (file 11 Task 11, docs/rebuild/11-todo-kpis.md "Money, Map Rank and navigation"):
// public/js/nav.js's NAV (the 9 items in Part A's exact order), routeFor (every hash → {page, id, params}; old and
// unknown routes open Todo), activeNav (which item is lit) and the Todo badge (gold count + red dot). nav.js is pure,
// so this runs in node. Later stages (09's sites/site/<id>, 10's client/<id>/client/settings) add their routes here.
// Run: node --test control-room/tests/nav.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { icon } from "../public/js/html.js";
import { NAV, activeNav, badgeHtml, badgeState, routeFor } from "../public/js/nav.js";

const js = (name) => readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");

test("nav order is exact", () => assert.deepEqual(NAV.map((n) => n[1]), ["Todo", "Leads", "Scraper", "Map Rank", "Replies", "KPIs", "Money", "Voice", "Setup"]));

test("routes", () => {
  for (const h of ["", "#/", "/#/", "#/todo", "#/home", "#/roadmap", "#/outreach", "#/nonsense"]) assert.equal(routeFor(h).page, "todo");
  const r = (h) => { const x = routeFor(h); return [x.page, x.id ?? null]; };
  assert.deepEqual(
    ["#/leads", "#/lead/p1", "#/lead/p1/thread", "#/scraper", "#/maprank", "#/replies", "#/replies/p1", "#/call/c1",
     "#/kpis", "#/money", "#/voice", "#/setup", "#/demo"].map(r),
    [["leads", null], ["lead", "p1"], ["replies", "p1"], ["scraper", null], ["maprank", null], ["replies", null],
     ["replies", "p1"], ["call", "c1"], ["kpis", null], ["money", null], ["voice", null], ["setup", null], ["demo", null]]);
  assert.equal(routeFor("#/kpis?week=2026-W43").params.get("week"), "2026-W43");
  assert.equal(routeFor("#/lead/ChIJ%2Fx").id, "ChIJ/x");
});

test("routes: edges (no hash, a bare #, queries, odd ids)", () => {
  for (const h of [undefined, null, "#", "/#", "#/todo?x=1", "#/home?x=1", "#/call", "#/call/", "#/Leads"]) {
    assert.equal(routeFor(h).page, "todo", String(h));
  }
  assert.ok(routeFor(undefined).params instanceof URLSearchParams);
  assert.deepEqual([routeFor("#/lead").page, routeFor("#/lead/").page, routeFor("#/lead").id ?? null], ["leads", "leads", null]);
  assert.deepEqual([routeFor("#/replies/").page, routeFor("#/replies/").id ?? null], ["replies", null]);
  assert.deepEqual([routeFor("#/lead/drill%3A1/thread").page, routeFor("#/lead/drill%3A1/thread").id], ["replies", "drill:1"]);
  assert.equal(routeFor("#/replies/drill%3A1?x=1").id, "drill:1");
  assert.equal(routeFor("#/lead/50%").id, "50%", "a malformed escape is kept as it is");
  assert.equal(routeFor("#/lead/x?view=all").params.get("view"), "all");
  assert.equal(routeFor("#/scraper?job=j1").params.get("job"), "j1");
  assert.equal(routeFor("#/maprank?scan=s1&biz=b2").params.get("biz"), "b2");
  assert.equal(routeFor("#/setup?at=business").params.get("at"), "business");
  assert.equal(routeFor("#/leads?view=all&grade=ap,a").params.get("grade"), "ap,a");
  assert.equal(routeFor("/#/kpis?week=2026-W43").page, "kpis");
});

test("every nav item routes to itself and has an icon", () => {
  for (const [route, label, name] of NAV) {
    assert.equal(routeFor(`#/${route}`).page, route, label);
    assert.ok(icon(name) !== icon("no-such-icon"), `the icon "${name}" isn't in html.js ICONS`);
  }
  assert.deepEqual(NAV.map((n) => n[0]), ["todo", "leads", "scraper", "maprank", "replies", "kpis", "money", "voice", "setup"]);
  // Demo and Call are routed, never nav items.
  assert.ok(!NAV.some((n) => n[0] === "demo" || n[0] === "call"));
});

test("activeNav: the page's own item, a lead lights Leads, Demo and Call light nothing", () => {
  for (const [route] of NAV) assert.equal(activeNav(route), route);
  assert.equal(activeNav("lead"), "leads");
  assert.equal(activeNav("demo"), null);
  assert.equal(activeNav("call"), null);
  assert.equal(activeNav("nonsense"), null);
});

test("Todo badge: the due count, a red dot when a light is red, hidden at 0 and 0", () => {
  assert.deepEqual(badgeState({ due: 0, red: 0 }), { hidden: true, due: 0, red: false });
  assert.deepEqual(badgeState({ due: 3, red: 0 }), { hidden: false, due: 3, red: false });
  assert.deepEqual(badgeState({ due: 0, red: 2 }), { hidden: false, due: 0, red: true });
  assert.deepEqual(badgeState({ due: "4", red: "1" }), { hidden: false, due: 4, red: true }, "D1 numbers as text");
  for (const bad of [null, undefined, "x", {}, { due: -1, red: -2 }, { due: NaN, red: "<b>" }, { due: "<img src=x>" }]) {
    assert.deepEqual(badgeState(bad), { hidden: true, due: 0, red: false }, JSON.stringify(bad));
  }
  assert.equal(badgeHtml({ due: 0, red: 0 }), "");
  const both = badgeHtml({ due: 12, red: 1 });
  assert.match(both, /<span class="nav-count">12<\/span>/);
  assert.match(both, /class="nav-red"/);
  assert.doesNotMatch(badgeHtml({ due: 3, red: 0 }), /nav-red/);
  assert.doesNotMatch(badgeHtml({ due: 0, red: 1 }), /nav-count/);
  assert.doesNotMatch(badgeHtml({ due: "<img src=x onerror=alert(1)>", red: 0 }), /<img/);
});

test("app.js: routes through routeFor, renders NAV flat with Log out under it, stops the Todo poll, fetches the badge", () => {
  const app = js("app.js");
  assert.match(app, /^import \{[^}]*\bNAV\b[^}]*\brouteFor\b[^}]*\} from "\.\/nav\.js";$/m);
  assert.match(app, /routeFor\(location\.hash\)/);
  assert.doesNotMatch(app, /\bPAGES\b|parseRoute|leadview\.js|home\.js|homePage/);
  for (const [fn, file] of [["todoPage", "todo"], ["stopTodoPoll", "todo"], ["kpisPage", "kpis"], ["repliesPage", "replies"],
    ["threadPage", "replies"], ["callPage", "call"], ["voicePage", "voice"], ["demoPage", "demo"], ["setupPage", "setup"],
    ["leadsPage", "leads"], ["openLeadDrawer", "leads"], ["mapRankRoute", "maprank"], ["scraperRoute", "scraper"], ["moneyPage", "money"]]) {
    assert.match(app, new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from "\\./${file}\\.js"`), fn);
  }
  // Every route change stops the Todo page's 60 s refresh first.
  const route = app.slice(app.indexOf("async function route()"));
  assert.ok(route.indexOf("stopTodoPoll()") >= 0 && route.indexOf("stopTodoPoll()") < route.indexOf("await "), "stopTodoPoll before the page renders");
  // #/lead/<id>: the Leads page first, then its panel.
  assert.ok(app.indexOf("leadsPage(params)") < app.indexOf("openLeadDrawer(id)"));
  assert.match(app, /id \? threadPage\(id\) : repliesPage\(\)/);
  assert.match(app, /callPage\(id\)/);
  // The badge: GET /api/todo/count after each route, kept current by the Todo page's own counts.
  assert.match(app, /\/api\/todo\/count/);
  assert.match(app, /todo-badge/);
  assert.match(app, /aetos:todo-counts/);
  assert.match(app, /href="\/logout"/);
  assert.ok(!/\bsoon\b/i.test(app));
  // No request to the old Home routes.
  assert.doesNotMatch(app, /api\/today|api\/overview/);
});

// Part A "Nav (exact order)": #/demo has no nav item, so it is linked from Setup and Leads, always (not only while a
// look waits for approval or the one-time setup Todo is open).
test("the Demo page is linked from Setup and Leads", () => {
  assert.ok(!NAV.some((n) => String(n[0]).includes("demo")));
  for (const page of ["setup.js", "leads.js"]) assert.ok(js(page).includes('href="#/demo"'), page);
});
