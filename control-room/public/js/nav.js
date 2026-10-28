// The nav and the one route list (file 11, docs/rebuild/11-todo-kpis.md "Money, Map Rank and navigation"). Pure: it
// never reads the page, so tests/nav.test.mjs runs it in node. app.js draws NAV and dispatches on routeFor's page.
// Later stages (09's sites/site/<id>, 10's client/<id>/client/settings) add their routes to routeFor and to
// nav.test.mjs, never a second list.
import { esc } from "./html.js";

/** [route, label, icon] in Part A's exact order; Log out sits under it. Demo and Call are routed but not listed. */
export const NAV = [
  ["todo", "Todo", "check"],
  ["leads", "Leads", "users"],
  ["scraper", "Scraper", "search"],
  ["maprank", "Map Rank", "map"],
  ["replies", "Replies", "mail"],
  ["kpis", "KPIs", "chart"],
  ["money", "Money", "pound"],
  ["voice", "Voice", "mic"],
  ["setup", "Setup", "sliders"],
];

// Pages whose first hash segment is their route, with nothing after it that matters.
const PLAIN = new Set(["todo", "leads", "scraper", "maprank", "kpis", "money", "voice", "setup", "demo"]);

// A malformed escape ("50%") is kept as it is: the page then says it can't find it.
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * The hash → {page, id, params}. `params` is the query after "?" (URLSearchParams); `id` the decoded id of
 * #/lead/<id>, #/replies/<id> and #/call/<id> (else absent). #/lead/<id>/thread opens that lead's Replies thread.
 * "", "#/", "/#/", the old Home, Roadmap and Outreach links, and anything unknown open Todo.
 */
export function routeFor(hash) {
  const raw = String(hash ?? "").replace(/^\/?#?\/?/, "");
  const at = raw.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  const [first, ...rest] = (at < 0 ? raw : raw.slice(0, at)).split("/");
  const tail = rest.join("/");
  if (PLAIN.has(first)) return { page: first, params };
  if (first === "lead") {
    if (rest.length > 1 && rest[rest.length - 1] === "thread" && rest.slice(0, -1).join("/")) {
      return { page: "replies", id: decode(rest.slice(0, -1).join("/")), params };
    }
    return tail ? { page: "lead", id: decode(tail), params } : { page: "leads", params };
  }
  if (first === "replies") return tail ? { page: "replies", id: decode(tail), params } : { page: "replies", params };
  if (first === "call" && tail) return { page: "call", id: decode(tail), params };
  return { page: "todo", params };
}

/** The nav item lit for a page: its own, Leads for one lead, none for Demo and Call (they have no item). */
export function activeNav(page) {
  if (page === "lead") return "leads";
  return NAV.some((n) => n[0] === page) ? page : null;
}

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** GET /api/todo/count's {due, red} → what the Todo badge shows: hidden at 0 and 0 (or an unreadable answer). */
export function badgeState(counts) {
  const due = count(counts?.due);
  const red = count(counts?.red) > 0;
  return { hidden: due === 0 && !red, due, red };
}

/** The badge's inside: the gold due count, and a red dot when any light is red. "" when there's nothing to show. */
export function badgeHtml(counts) {
  const s = badgeState(counts);
  if (s.hidden) return "";
  const num = s.due ? `<span class="nav-count">${esc(s.due)}</span>` : "";
  const dot = s.red ? '<span class="nav-red" title="A light is red"></span>' : "";
  return num + dot;
}

/** Words for screen readers: "3 due today, a light is red". */
export function badgeLabel(counts) {
  const s = badgeState(counts);
  const parts = [];
  if (s.due) parts.push(`${s.due} due today`);
  if (s.red) parts.push("a light is red");
  return parts.join(", ");
}
