// POST /api/agent/build/<client_id>/content (agent token; body = SiteContent v1): the build Routine posts a client's
// whole site (stage 10, docs/rebuild/09-build.md Part A §6). In this order: the size (over 600,000 bytes → 413), the
// JSON, validateContent against the client's form, Google reviews, brand and files (every problem at once → 400 {ok:
// false, errors}, also kept in client_sites.last_errors for the Site page), copyPhotos (their photos and logo copied
// into site_files; what can't be copied comes back in `warnings`), saveContent, then the todos: build:<id>:stuck is
// closed, and either "Approve {name}'s site (due live Ddd d Mmm)" (build:<id>:approve, due 48 h before the deadline)
// or, for a site already live (Nik asked for changes, or a stage 11 care change), "Claude updated {name}'s live site:
// have a look" (build:<id>:updated); a live site stays live and serves the new content at once.
// → 200 {ok: true, status, pages, warnings}. A refused post stores nothing but last_errors.
// `context.now` and `context.fetchImpl` are for tests. Tested in tests/sites-agent-build.test.mjs.
import { requireAgent } from "../../../../_lib/agentAuth.js";
import { LIMITS, validateContent } from "../../../../_lib/sites/content.js";
import { oneLine } from "../../../../_lib/sites/copy.js";
import { ukShortDay } from "../../../../_lib/sites/countdown.js";
import { ensureSite, saveContent } from "../../../../_lib/sites/db.js";
import { copyPhotos } from "../../../../_lib/sites/files.js";
import { addTodo, closeTodos } from "../../../../_lib/todo.js";
import { db, iso, json } from "../../../../_lib/util.js";
import { buildContext, loadBuildClient } from "../[client_id].js";

export const TOO_BIG = `The site content is over ${LIMITS.bytes / 1000} KB.`;
const NOT_JSON = "The body isn't valid JSON: post the SiteContent document as one JSON object";
const APPROVE_LEAD_MS = 48 * 3600 * 1000; // the Approve todo is due 48 h before the site must be live

// {ok, text} with at most LIMITS.bytes read: Content-Length first, then the bytes as they arrive.
async function readCapped(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.bytes) return { ok: false };
  if (!request.body || typeof request.body.getReader !== "function") {
    const text = await request.text();
    return new TextEncoder().encode(text).length > LIMITS.bytes ? { ok: false } : { ok: true, text };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.bytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

// A refusal: stored for the Site page ("Claude's last try was refused: …"), then answered. No row → nothing stored.
async function refuse(DB, client_id, errors, status, now) {
  if (typeof client_id === "string" && client_id) {
    await DB.prepare("UPDATE client_sites SET last_errors = ?, updated_at = ? WHERE client_id = ?")
      .bind(JSON.stringify(errors), iso(now), client_id)
      .run();
  }
  return json(status === 413 ? { ok: false, error: errors[0], errors } : { ok: false, errors }, status);
}

// Files a todo by its exact dedupe. One Nik already closed (done or dismissed) is freed first, as closeTodos frees
// an open one, so new content is always a new thing to look at; an open one is kept as it is (addTodo ignores it).
// The freed dedupe ends with the todo's own id too: Nik's Done stamps done_at to the second, so two of these closed
// in the same second would otherwise free to the same text, and the UNIQUE dedupe would fail every later post.
async function refile(DB, todo, now) {
  await DB.prepare(
    `UPDATE todos SET dedupe = dedupe || '@' || COALESCE(done_at, ?) || '#' || id WHERE dedupe = ? AND status <> 'open'`,
  )
    .bind(iso(now), todo.dedupe)
    .run();
  return addTodo(DB, todo);
}

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const now = context.now ?? new Date();
  const fetchImpl = context.fetchImpl ?? env?.__fetch; // tests only; live both are undefined, so copyPhotos uses fetch
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;
  const clientId = typeof params?.client_id === "string" ? params.client_id : "";

  // 1. Size, before anything is parsed.
  const body = await readCapped(request);
  if (!body.ok) return refuse(DB, clientId, [TOO_BIG], 413, now);

  // 2. The JSON.
  let content;
  try {
    content = JSON.parse(body.text);
  } catch {
    return refuse(DB, clientId, [NOT_JSON], 400, now);
  }

  // 3. The client, and everything the content is checked against.
  const loaded = await loadBuildClient(DB, clientId);
  if (loaded.denied) return loaded.denied;
  const { row, form } = loaded;
  await ensureSite(DB, row.id, { name: row.name, place_id: row.place_id ?? null }, now);
  const ctx = await buildContext(DB, row.id, row.place_id);
  const checked = validateContent(content, { form, reviews: ctx.reviews, brand: ctx.brand, files: ctx.files, package: row.package });
  if (!checked.ok) return refuse(DB, row.id, checked.errors, 400, now);

  // 4. Photos into site_files, 5. stored.
  const copied = await copyPhotos(DB, row.id, content, fetchImpl ? { fetchImpl, now } : { now });
  const saved = await saveContent(DB, row.id, copied.content, now);
  const status = saved?.status ?? "review";

  // 6. Todos.
  await closeTodos(DB, `build:${row.id}:stuck`);
  const name = oneLine(row.name) || oneLine(content.business?.name) || "This client";
  const base = { kind: "build", link: `/#/site/${row.id}`, client_id: row.id, place_id: row.place_id ?? null };
  if (status === "live") {
    await refile(DB, { ...base, title: `Claude updated ${name}'s live site: have a look`, dedupe: `build:${row.id}:updated`,
      detail: "The new content is already on their live site. Open the Site page to check it, and ask Claude for changes if anything's off." }, now);
  } else {
    const due = row.due_live_at ? Date.parse(row.due_live_at) : NaN;
    await refile(DB, {
      ...base,
      title: Number.isFinite(due) ? `Approve ${name}'s site (due live ${ukShortDay(row.due_live_at)})` : `Approve ${name}'s site`,
      detail: "Open the previews on the Site page, then press Approve, or ask Claude for changes.",
      due_at: Number.isFinite(due) ? new Date(due - APPROVE_LEAD_MS) : null,
      dedupe: `build:${row.id}:approve`,
    }, now);
  }

  const pages = Array.isArray(copied.content?.pages) ? copied.content.pages.length : 0;
  return json({ ok: true, status, pages, warnings: copied.warnings });
}
