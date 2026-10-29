// SiteContent body text as HTML (stage 10, docs/rebuild/09-build.md Part A §5, Part B Task 4). Pure.
//
// The body format is parseBody's (sites/content.js): paragraphs split by a blank line, "- " bullet lists and
// [words](/path) links to pages of the same site. Everything is escaped with h(); a link becomes <a> only when its
// target is a plain path on this site (one leading "/", path characters only), so nothing Claude writes can link
// elsewhere, run script or break out of the attribute (the validator refuses those already; this is the second
// line). `base` is the prefix the site is served under: "" on the client's own host, "/c/<slug>" in Nik's preview,
// "/w/<slug>" on the temporary link. Tested in control-room/tests/sites-render.test.mjs.
import { h } from "../demo/text.js";
import { parseBody } from "./content.js";

// A path prefix: "" or "/seg/seg" (no trailing slash, no "..", path characters only).
const BASE = /^(?:\/[A-Za-z0-9._~-]+)*$/;
// A page path on this site: "/" or "/seg/seg", never "//" (another site) or "/\".
const PAGE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;

/** The base as given when it is a plain path prefix ("/c/smith-roofing-ab12cd"), else "". */
export function cleanBase(base) {
  return typeof base === "string" && BASE.test(base) && !base.split("/").includes("..") ? base : "";
}

/** The href of a page path under `base` ("/" → "/c/s1/", "/about" → "/c/s1/about"); "" when `path` isn't one. */
export function hrefFor(base, path) {
  if (typeof path !== "string" || !PAGE_PATH.test(path) || path.split("/").includes("..")) return "";
  const b = cleanBase(base);
  return path === "/" ? `${b}/` : `${b}${path}`;
}

/** Text parts ({text} or {text, href}) as escaped HTML: links to this site's pages, everything else as words. */
export function partsHtml(parts, base) {
  return (Array.isArray(parts) ? parts : []).map((p) => {
    const href = typeof p?.href === "string" ? hrefFor(base, p.href) : "";
    return href ? `<a href="${h(href)}">${h(p.text)}</a>` : h(p?.text);
  }).join("");
}

/** A body (SiteContent sections[].body) as HTML: <p> per paragraph, <ul><li> per bullet list, one block a line. */
export function bodyHtml(text, base) {
  return parseBody(typeof text === "string" ? text : "").map((b) => (b.type === "ul"
    ? `<ul>${b.items.map((item) => `<li>${partsHtml(item, base)}</li>`).join("")}</ul>`
    : `<p>${partsHtml(b.parts, base)}</p>`)).join("\n");
}
