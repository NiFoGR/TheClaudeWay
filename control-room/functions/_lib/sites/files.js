// Client photos and logos (stage 10, docs/rebuild/09-build.md section 10, Task 13).
//
// copyPhotos: when Claude posts a site's content, every https:// photos[].url and theme.logo is fetched (8 s timeout,
// at most MAX_FETCHES per post, 4 at a time), kept only when it answers a JPEG, PNG, WebP or GIF of at most 400 KB
// whose size can be read from its header, and stored in site_files under a random 32-hex id; the content then points
// at /s/f/<id> and carries the size (photos[].w/h, theme.logo_w/logo_h), so the site never hot-links their old host
// and every <img> has its width and height. A URL this client already has a copy of is reused, not fetched again, and
// an /s/f/ URL gets its size from the stored file. What fails is dropped from the content (pages[].photo indexes are
// moved to match) and comes back as a plain-English warning; when more than half fail, a build todo asks Nik to add
// photos. SVG is never accepted (it can carry scripts).
//
// saveUpload stores a photo Nik picked on the Site page (shrunk in his browser first); serveFile answers /s/f/<id>
// with a year-long immutable cache through the Cache API (D1 is read once per Cloudflare location); deleteFile and
// listFiles back the Site page's photo list. imageSize is pure. Tested in control-room/tests/sites-files.test.mjs.
//
// D1 budget: copyPhotos 1 read (this client's files, without bytes) + 1 insert per copied image + at most 2 for the
// todo (client name, insert); saveUpload 1; serveFile 0 on a cache hit, else 1; deleteFile 2; listFiles 1.
import { cleanText } from "../demo/text.js";
import { addTodo } from "../todo.js";
import { iso } from "../util.js";

/** Largest photo or logo stored, in bytes ("≤ 400 KB", section 10). */
export const MAX_PHOTO_BYTES = 400_000;
/** At most this many photos/logos fetched per content post. */
export const MAX_FETCHES = 12;
/** The only types stored and served. Never SVG. */
export const IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const FETCH_TIMEOUT_MS = 8000;
export const FILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const FILE_URL = /^\/s\/f\/([0-9a-f]{32})$/;
const ID = /^[0-9a-f]{32}$/;
const MAX_SIDE = 20_000; // sitedata.js prints sizes up to this
const PARALLEL = 4;
const COUNT_CAP = 20_000_000; // past the limit, bytes are only counted (for the warning), up to this
const ALT_MAX = 200;
const DEFAULT_ORIGIN = "https://aetoswebsites.com";
// The scraper's browser user-agent (lead-manager/aetos_leads/audit.py), so a site that found these photos for the
// scraper doesn't turn this fetch away (many refuse requests with no user-agent).
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const TOO_BIG_UPLOAD = "That photo is still over 400 KB after shrinking. Try a smaller one.";
const NOT_IMAGE_UPLOAD = "That file isn't a photo we can use. Pick a JPEG, PNG, WebP or GIF image.";
const GONE = "That photo isn't there any more.";
const IN_USE = "That photo is on the site. Ask Claude for changes to take it off first, then delete it.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- image headers (pure)

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

// EXIF orientation (tag 0x0112 in IFD0 of an APP1 "Exif\0\0" segment at `at`, `len` bytes): 1-8, or 0 for none.
function exifOrientation(b, at, len) {
  const end = Math.min(b.length, at + len);
  if (len < 16 || !ascii(b, at, "Exif") || b[at + 4] !== 0 || b[at + 5] !== 0) return 0;
  const t = at + 6; // TIFF header: "II" (little-endian) or "MM", 42, offset of IFD0
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 0;
  const r16 = (i) => (i + 1 < end ? (le ? u16le(b, i) : u16be(b, i)) : -1);
  const r32 = (i) => (i + 3 < end ? (le ? u32le(b, i) : u32be(b, i)) : -1);
  if (r16(t + 2) !== 42) return 0;
  const ifd = t + r32(t + 4);
  const count = r16(ifd);
  if (ifd <= t || count < 0) return 0;
  for (let k = 0; k < count && k < 500; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 0;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

// JPEG: walk the segments to the first start-of-frame (SOF0-3, 5-7, 9-11, 13-15): precision, height, width. An EXIF
// orientation of 5-8 (turned a quarter) swaps them, as browsers show the photo turned.
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let orientation = 0;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { // fill bytes
      i++;
      marker = b[i + 1];
    }
    i += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame
    if (i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (i + 6 >= b.length || len < 7) return null;
      const w = u16be(b, i + 5);
      const h = u16be(b, i + 3);
      return orientation >= 5 ? { w: h, h: w } : { w, h };
    }
    if (marker === 0xe1 && !orientation) orientation = exifOrientation(b, i + 2, len - 2);
    i += len;
  }
  return null;
}

// PNG: the signature, then the IHDR chunk (width, height as 32-bit big-endian).
function pngSize(b) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((x, k) => b[k] === x) || !ascii(b, 12, "IHDR")) return null;
  return { w: u32be(b, 16), h: u32be(b, 20) };
}

// GIF: "GIF87a" / "GIF89a", then the logical screen width and height (16-bit little-endian).
function gifSize(b) {
  if (b.length < 10 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  return { w: u16le(b, 6), h: u16le(b, 8) };
}

// WebP: RIFF....WEBP, then the first chunk: VP8 (lossy key frame), VP8L (lossless) or VP8X (extended canvas).
function webpSize(b) {
  if (b.length < 16 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8X")) return b.length < 30 ? null : { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  return null;
}

const READERS = { "image/jpeg": jpegSize, "image/png": pngSize, "image/webp": webpSize, "image/gif": gifSize };

// Names some servers use for the same types (the bytes are checked either way; stored under the standard name).
const MIME_ALIASES = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };

/** "image/jpeg" from a Content-Type like "Image/JPEG; charset=binary" (or "image/jpg"); "" for none. */
export function baseMime(type) {
  const t = String(type ?? "").split(";")[0].trim().toLowerCase();
  return MIME_ALIASES[t] ?? t;
}

/**
 * The pixel size from an image's header, for the type it claims: {w, h}, or null when the bytes aren't that type
 * (or the type isn't JPEG, PNG, WebP or GIF), the header is cut short, or a side is 0 or over 20,000. Pure.
 */
export function imageSize(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return null;
  const read = READERS[baseMime(mime)];
  const size = read ? read(bytes) : null;
  if (!size) return null;
  const ok = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_SIDE;
  return ok(size.w) && ok(size.h) ? { w: size.w, h: size.h } : null;
}

// ---------------------------------------------------------------- storing

function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** "500 KB" / "1.2 MB", rounded up so a file just over the limit never reads as the limit. */
export function sizeText(n) {
  return n >= 1_000_000 ? `${Math.ceil(n / 100_000) / 10} MB` : `${Math.ceil(n / 1000)} KB`;
}

const cleanAlt = (alt) => cleanText(typeof alt === "string" ? alt : "", ALT_MAX);

async function storeFile(DB, client_id, { kind, mime, bytes, size, source_url, alt }, now) {
  const id = newId();
  await DB.prepare(
    `INSERT INTO site_files (id, client_id, kind, mime, bytes, size, width, height, source_url, alt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, client_id, kind, mime, bytes, bytes.length, size.w, size.h, source_url ?? null, cleanAlt(alt), iso(now))
    .run();
  return id;
}

/** This client's files, newest first, without the bytes: [{id, kind, url, mime, size, width, height, alt, source_url, created_at}]. */
export async function listFiles(DB, client_id) {
  const { results } = await DB.prepare(
    `SELECT id, kind, mime, size, width, height, alt, source_url, created_at FROM site_files
     WHERE client_id = ? ORDER BY created_at DESC, id`,
  )
    .bind(client_id)
    .all();
  return results.map((r) => ({ ...r, url: `/s/f/${r.id}` }));
}

// ---------------------------------------------------------------- copyPhotos

// The body, at most MAX_PHOTO_BYTES kept; past that only counted (so the warning can say how big it was).
async function readCapped(res) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > MAX_PHOTO_BYTES ? { over: bytes.length } : { bytes };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= MAX_PHOTO_BYTES) chunks.push(value);
    else chunks.length = 0;
    if (total > COUNT_CAP) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  if (total > MAX_PHOTO_BYTES) return { over: total };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes };
}

const errText = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 120);

// One image: {ok: true, mime, bytes, size} or {ok: false, why} (the end of the warning sentence).
async function fetchImage(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow", headers: { accept: IMAGE_TYPES.join(", "), "user-agent": USER_AGENT } });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, why: timeout ? "didn't answer within 8 seconds: add a copy on the Site page." : `couldn't be fetched (${errText(err)}): add a copy on the Site page.` };
  }
  const drop = () => res.body?.cancel?.().catch(() => {});
  if (!res.ok) {
    drop();
    return { ok: false, why: `couldn't be fetched (their site answered ${res.status}): add a copy on the Site page.` };
  }
  const mime = baseMime(res.headers.get("content-type"));
  if (!IMAGE_TYPES.includes(mime)) {
    drop();
    return { ok: false, why: `is ${mime || "not marked as an image"}, not a JPEG, PNG, WebP or GIF: add a copy on the Site page.` };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
    drop();
    return { ok: false, why: `was ${sizeText(declared)} (limit 400 KB): add a smaller copy on the Site page.` };
  }
  let body;
  try {
    body = await readCapped(res);
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, why: timeout ? "didn't answer within 8 seconds: add a copy on the Site page." : `couldn't be read (${errText(err)}): add a copy on the Site page.` };
  }
  if (body.over) return { ok: false, why: `was ${sizeText(body.over)} (limit 400 KB): add a smaller copy on the Site page.` };
  const size = imageSize(body.bytes, mime);
  if (!size) return { ok: false, why: `couldn't be read as a ${mime.slice(6).toUpperCase()} image: add a copy on the Site page.` };
  return { ok: true, mime, bytes: body.bytes, size };
}

// Runs fn over items, `limit` at a time, results in order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const httpsUrl = (u) => {
  if (typeof u !== "string") return "";
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};

/**
 * Copy the content's photos and logo into site_files (section 10). Returns {content, warnings}: a new content object
 * (the one passed in isn't changed) whose photos[] and theme.logo are /s/f/<id> URLs with w/h (theme.logo_w/logo_h),
 * without the images that couldn't be copied; `warnings` says why each one was dropped. More than half failing files
 * the todo build:<client_id>:photos. `fetchImpl` defaults to fetch; `now` stamps created_at.
 */
export async function copyPhotos(DB, client_id, content, { fetchImpl = fetch, now = new Date() } = {}) {
  const out = structuredClone(content);
  const warnings = [];
  if (!isObj(out)) return { content: out, warnings };
  const photos = Array.isArray(out.photos) ? out.photos : [];
  const theme = isObj(out.theme) ? out.theme : null;

  // Every image in the content: photos first, then the logo.
  const items = photos.map((p, i) => ({ kind: "photo", label: "Photo", index: i, url: isObj(p) ? p.url : undefined, alt: isObj(p) ? p.alt : "" }));
  if (theme && typeof theme.logo === "string" && theme.logo !== "") {
    items.push({ kind: "logo", label: "Logo", url: theme.logo, alt: `${cleanText(out.business?.name ?? "", 100)} logo`.trim() });
  }
  if (!items.length) return { content: out, warnings };

  // This client's files (no bytes): /s/f/ sizes, and copies of a URL made before.
  const { results } = await DB.prepare("SELECT id, width, height, source_url FROM site_files WHERE client_id = ?").bind(client_id).all();
  const byId = new Map(results.map((r) => [r.id, r]));
  const bySource = new Map(results.filter((r) => r.source_url).map((r) => [r.source_url, r]));

  // What each image becomes: {id, w, h} or {why}.
  const fetches = new Map(); // https URL → index into toFetch (fetched once even when used twice)
  const toFetch = [];
  for (const item of items) {
    const file = typeof item.url === "string" ? FILE_URL.exec(item.url.trim()) : null;
    if (file) {
      const row = byId.get(file[1]);
      item.result = row ? { id: row.id, w: row.width, h: row.height } : { why: "isn't one of this client's files: pick one from files or add it on the Site page." };
      continue;
    }
    const url = httpsUrl(item.url);
    if (!url) {
      item.result = { why: "isn't an https:// image address, so it can't be copied: add a copy on the Site page." };
      continue;
    }
    item.source = url;
    const had = bySource.get(url);
    if (had) {
      item.result = { id: had.id, w: had.width, h: had.height };
      continue;
    }
    if (!fetches.has(url)) {
      if (toFetch.length >= MAX_FETCHES) {
        item.result = { why: `wasn't copied: at most ${MAX_FETCHES} photos are copied each time. Add it on the Site page.` };
        continue;
      }
      fetches.set(url, toFetch.length);
      toFetch.push({ url, kind: item.kind, alt: item.alt });
    }
    item.pending = fetches.get(url);
  }

  const fetched = await pool(toFetch, PARALLEL, async (f) => {
    const got = await fetchImage(f.url, fetchImpl);
    if (!got.ok) return { why: got.why };
    const id = await storeFile(DB, client_id, { kind: f.kind, mime: got.mime, bytes: got.bytes, size: got.size, source_url: f.url, alt: f.alt }, now);
    return { id, w: got.size.w, h: got.size.h };
  });
  for (const item of items) if (item.pending !== undefined) item.result = fetched[item.pending];

  // Apply: keep what was copied, drop the rest (and move pages[].photo to the photos' new places).
  const newIndex = new Map();
  const kept = [];
  let failed = 0;
  for (const item of items) {
    const r = item.result;
    if (r.why) {
      failed++;
      warnings.push(`${item.label} ${typeof item.url === "string" ? cleanText(item.url, 300) : "(no address)"} ${r.why}`);
      continue;
    }
    if (item.kind === "photo") {
      newIndex.set(item.index, kept.length);
      kept.push({ ...photos[item.index], url: `/s/f/${r.id}`, w: r.w, h: r.h });
    } else {
      theme.logo = `/s/f/${r.id}`;
      theme.logo_w = r.w;
      theme.logo_h = r.h;
    }
  }
  if (Array.isArray(out.photos)) out.photos = kept;
  if (theme && items.some((i) => i.kind === "logo" && i.result.why)) {
    delete theme.logo;
    delete theme.logo_w;
    delete theme.logo_h;
  }
  if (Array.isArray(out.pages)) {
    for (const page of out.pages) {
      if (!isObj(page) || page.photo === undefined || page.photo === null) continue;
      if (newIndex.has(page.photo)) page.photo = newIndex.get(page.photo);
      else delete page.photo;
    }
  }

  if (failed * 2 > items.length) {
    const client = await DB.prepare("SELECT name, place_id FROM clients WHERE id = ?").bind(client_id).first();
    const name = cleanText(client?.name ?? "", 100) || cleanText(out.business?.name ?? "", 100) || "this client";
    await addTodo(DB, {
      kind: "build",
      title: `Add photos for ${name}: ${failed} of their photos were too big or missing`,
      detail: warnings.join("\n"),
      link: `/#/site/${client_id}`,
      client_id,
      place_id: client?.place_id ?? null,
      dedupe: `build:${client_id}:photos`,
    });
  }
  return { content: out, warnings };
}

// ---------------------------------------------------------------- uploads, delete

/**
 * Store a photo Nik uploaded on the Site page (shrunk in his browser to WebP). `bytes` a Uint8Array (or ArrayBuffer),
 * `mime` its type. Returns {ok: true, id, width, height} or {ok: false, error} in plain English.
 */
export async function saveUpload(DB, client_id, { bytes, mime, alt } = {}, now = new Date()) {
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  const type = baseMime(mime);
  if (!data || !data.length || !IMAGE_TYPES.includes(type)) return { ok: false, error: NOT_IMAGE_UPLOAD };
  if (data.length > MAX_PHOTO_BYTES) return { ok: false, error: TOO_BIG_UPLOAD };
  const size = imageSize(data, type);
  if (!size) return { ok: false, error: NOT_IMAGE_UPLOAD };
  const id = await storeFile(DB, client_id, { kind: "photo", mime: type, bytes: data, size, source_url: null, alt }, now);
  return { ok: true, id, width: size.w, height: size.h };
}

/**
 * Delete one of this client's files. Refused while the site's content still shows it (the page would show a broken
 * picture). Returns {ok: true} or {ok: false, status: 404|409, error}.
 */
export async function deleteFile(DB, client_id, id) {
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, status: 404, error: GONE };
  const content = await DB.prepare("SELECT content FROM client_sites WHERE client_id = ?").bind(client_id).first("content");
  if (typeof content === "string" && content.includes(`/s/f/${id}`)) return { ok: false, status: 409, error: IN_USE };
  const { meta } = await DB.prepare("DELETE FROM site_files WHERE id = ? AND client_id = ?").bind(id, client_id).run();
  return meta.changes ? { ok: true } : { ok: false, status: 404, error: GONE };
}

// ---------------------------------------------------------------- serving

const notFound = () => new Response("That photo isn't here.", {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

/**
 * The response for /s/f/<id>: the bytes with their type and a year-long immutable cache, or a plain 404. `cache` is
 * caches.default when the runtime has it: a hit is returned without reading D1, a miss is read from D1 and put.
 * The cache key is `${origin}/s/f/<id>` with no query (so ?x=… can't force D1 reads); `origin` defaults to our host.
 * `client_id`, when given, serves only that client's files. With `waitUntil` the put runs after the answer; a cache
 * that fails is skipped. `DB` may be a function returning the database (a promise is fine): it is then called only on
 * a cache miss, so a hit never touches D1 at all.
 */
export async function serveFile(DB, id, { cache, origin = DEFAULT_ORIGIN, client_id, waitUntil } = {}) {
  if (typeof id !== "string" || !ID.test(id)) return notFound();
  const key = `${String(origin).replace(/\/+$/, "")}/s/f/${id}`;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (err) {
      console.error(`The photo cache couldn't be read: ${errText(err)}`);
    }
  }
  const D1 = typeof DB === "function" ? await DB() : DB;
  const row = client_id
    ? await D1.prepare("SELECT mime, bytes FROM site_files WHERE id = ? AND client_id = ?").bind(id, client_id).first()
    : await D1.prepare("SELECT mime, bytes FROM site_files WHERE id = ?").bind(id).first();
  if (!row || !IMAGE_TYPES.includes(row.mime)) return notFound();
  const bytes = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes); // D1 gives an array of bytes
  const res = new Response(bytes, {
    headers: {
      "content-type": row.mime,
      "content-length": String(bytes.length),
      "cache-control": FILE_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
  if (cache) {
    const copy = res.clone(); // now, before the caller reads the body
    const put = Promise.resolve().then(() => cache.put(key, copy)).catch((err) => {
      console.error(`The photo cache couldn't be written: ${errText(err)}`);
    });
    if (typeof waitUntil === "function") waitUntil(put);
    else await put;
  }
  return res;
}
