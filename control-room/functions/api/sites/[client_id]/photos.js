// The Site page's photos (stage 10, docs/rebuild/09-build.md sections 10 and 13), behind the login (_middleware.js).
//   GET    /api/sites/<client_id>/photos → {files: [{id, kind, url, mime, size, width, height, alt, source_url, created_at}]}
//   POST   /api/sites/<client_id>/photos → {ok: true, id, url, width, height} | 400 {ok: false, error}
//          Body: multipart form-data with `photo` (the image, shrunk in the browser to WebP) and `alt`, or the raw
//          image bytes with their Content-Type and ?alt=… . At most 400 KB; JPEG, PNG, WebP or GIF only (never SVG).
//   DELETE /api/sites/<client_id>/photos?id=<id> (or a JSON body {id}) → {ok: true} | 404/409 {error}
// 404 {error: "No client with that id."} for an unknown client. The work is _lib/sites/files.js; tested in
// control-room/tests/sites-files.test.mjs.
import { deleteFile, listFiles, MAX_PHOTO_BYTES, saveUpload } from "../../../_lib/sites/files.js";
import { bad, db, json } from "../../../_lib/util.js";

const NO_CLIENT = "No client with that id.";
const TOO_BIG = "That photo is still over 400 KB after shrinking. Try a smaller one.";
const NO_PHOTO = "Pick a photo to add.";
// Room for a multipart wrapper around a photo at the limit.
const MAX_BODY = MAX_PHOTO_BYTES + 64 * 1024;

const clientIdOf = (params) => (typeof params?.client_id === "string" ? params.client_id : "");

async function clientExists(DB, client_id) {
  return Boolean(client_id) && (await DB.prepare("SELECT 1 AS ok FROM clients WHERE id = ?").bind(client_id).first("ok")) === 1;
}

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  const client_id = clientIdOf(params);
  if (!(await clientExists(DB, client_id))) return bad(NO_CLIENT, 404);
  return json({ files: await listFiles(DB, client_id) });
}

// The photo, its type and alt text from the request: {bytes, mime, alt} or {error}.
async function readPhoto(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return { error: TOO_BIG };
  const type = String(request.headers.get("content-type") || "").toLowerCase();
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const file = form?.get("photo") ?? form?.get("file");
    if (!file || typeof file === "string") return { error: NO_PHOTO };
    if (file.size > MAX_BODY) return { error: TOO_BIG };
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, alt: String(form.get("alt") ?? "") };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return { error: NO_PHOTO };
  if (bytes.length > MAX_BODY) return { error: TOO_BIG };
  return { bytes, mime: type, alt: new URL(request.url).searchParams.get("alt") ?? "" };
}

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const DB = await db(env);
  const client_id = clientIdOf(params);
  if (!(await clientExists(DB, client_id))) return bad(NO_CLIENT, 404);
  const photo = await readPhoto(request);
  if (photo.error) return json({ ok: false, error: photo.error }, 400);
  const saved = await saveUpload(DB, client_id, photo, now ?? new Date());
  if (!saved.ok) return json({ ok: false, error: saved.error }, 400);
  return json({ ok: true, id: saved.id, url: `/s/f/${saved.id}`, width: saved.width, height: saved.height });
}

export async function onRequestDelete({ request, env, params }) {
  const DB = await db(env);
  const client_id = clientIdOf(params);
  if (!(await clientExists(DB, client_id))) return bad(NO_CLIENT, 404);
  let id = new URL(request.url).searchParams.get("id");
  if (!id) {
    const body = await request.json().catch(() => null);
    id = body && typeof body === "object" && typeof body.id === "string" ? body.id : "";
  }
  const out = await deleteFile(DB, client_id, id);
  return out.ok ? json({ ok: true }) : bad(out.error, out.status);
}
