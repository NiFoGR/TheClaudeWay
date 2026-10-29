// Client photos and logos (stage 10, 09-build.md section 10, Task 13): image sizes read from the header, photos copied
// from their old site into D1 (site_files) with the URL replaced by /s/f/<id>, Nik's uploads, and /s/f/<id> served
// with a year-long immutable cache through the Cache API. SVG is never accepted.
// Run: node --test control-room/tests/sites-files.test.mjs control-room/tests/site.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";
import {
  copyPhotos, deleteFile, imageSize, listFiles, MAX_FETCHES, MAX_PHOTO_BYTES, saveUpload, serveFile,
} from "../functions/_lib/sites/files.js";
import * as photosRoute from "../functions/api/sites/[client_id]/photos.js";
import * as fileRoute from "../functions/s/f/[id].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const AT = new Date("2026-10-28T10:00:00Z");
const T0 = "2026-10-24T22:30:00Z";
const HEX32 = /^[0-9a-f]{32}$/;
const FILE = /^\/s\/f\/([0-9a-f]{32})$/;

const fixture = (ext) => new Uint8Array(readFileSync(new URL(`./fixtures/img/3x2.${ext}`, import.meta.url)));
const JPG = fixture("jpg");
const PNG = fixture("png");
const WEBP = fixture("webp");
const GIF = fixture("gif");
// A real JPEG padded to exactly 1,000 bytes (bytes after the end marker are ignored by readers).
const JPG_1000 = (() => {
  const out = new Uint8Array(1000);
  out.set(JPG);
  return out;
})();

// Deterministic "random" bytes: no image header at all.
const junk = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 73 + 41) % 251);

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

async function seed() {
  const DB = fakeD1();
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", place_id: "p1", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-24", created_at: T0,
  });
  return DB;
}

const img = (bytes, type = "image/jpeg", extra = {}) => new Response(bytes, { status: 200, headers: { "content-type": type, ...extra } });

/** The spec's fake fetch: /a.jpg 1,000 bytes, /big.jpg 500 KB, /x.svg SVG, /gone.jpg 404; /pN.jpg small JPEGs. */
function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname;
    if (path === "/a.jpg") return img(JPG_1000);
    if (path === "/big.jpg") return img(new Uint8Array(500_000));
    if (path === "/x.svg") return img(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
    if (path === "/gone.jpg") return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
    if (path === "/junk.jpg") return img(junk(1000));
    if (path === "/logo.png") return img(PNG, "image/png");
    if (path === "/photo.webp") return img(WEBP, "image/webp; charset=binary");
    if (/^\/p\d+\.jpg$/.test(path)) return img(JPG);
    if (path === "/declared-big.jpg") return img(JPG, "image/jpeg", { "content-length": "1200000" });
    if (path === "/slow.jpg") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response("?", { status: 500 });
  };
  return { fetchImpl, calls };
}

const content = (photos, extra = {}) => ({
  version: 1,
  business: { name: "Smith Roofing" },
  theme: { main: "#1e4f86" },
  pages: [{ key: "home", path: "/", photo: 0 }, { key: "about", path: "/about", photo: 1 }],
  photos,
  ...extra,
});
const ph = (path, alt = `Roof ${path}`) => ({ url: `https://old.site${path}`, alt });

// ---------------------------------------------------------------- imageSize

test("imageSize reads the committed 3x2 JPEG, PNG, WebP and GIF fixtures", () => {
  assert.deepEqual(imageSize(JPG, "image/jpeg"), { w: 3, h: 2 });
  assert.deepEqual(imageSize(PNG, "image/png"), { w: 3, h: 2 });
  assert.deepEqual(imageSize(WEBP, "image/webp"), { w: 3, h: 2 });
  assert.deepEqual(imageSize(GIF, "image/gif"), { w: 3, h: 2 });
  assert.deepEqual(imageSize(JPG_1000, "image/jpeg"), { w: 3, h: 2 }, "padding after the image is ignored");
});

test("imageSize: null for random bytes, empty input, a mime that doesn't match the bytes, and SVG", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
    assert.equal(imageSize(junk(1000), mime), null, mime);
    assert.equal(imageSize(new Uint8Array(0), mime), null, mime);
    assert.equal(imageSize(JPG.slice(0, 10), mime), null, `${mime}: truncated`);
  }
  assert.equal(imageSize(PNG, "image/jpeg"), null, "PNG bytes labelled JPEG");
  assert.equal(imageSize(JPG, "image/gif"), null);
  assert.equal(imageSize(new TextEncoder().encode("<svg width='3' height='2'/>"), "image/svg+xml"), null);
  assert.equal(imageSize(PNG, "text/html"), null);
  assert.equal(imageSize(null, "image/png"), null);
});

test("imageSize reads WebP lossless (VP8L) and extended (VP8X) headers too", () => {
  const riff = (chunk, payload) => {
    const out = new Uint8Array(20 + payload.length);
    out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    out.set([...chunk].map((c) => c.charCodeAt(0)), 12);
    out.set(payload, 20);
    return out;
  };
  // VP8L: signature 0x2f, then 14 bits width-1 and 14 bits height-1, little-endian. 1200 x 800.
  const bits = (1200 - 1) | ((800 - 1) << 14);
  const vp8l = riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
  assert.deepEqual(imageSize(vp8l, "image/webp"), { w: 1200, h: 800 });
  // VP8X: 4 bytes of flags, then 24-bit canvas width-1 and height-1. 1600 x 1067.
  const w = 1600 - 1;
  const h = 1067 - 1;
  const vp8x = riff("VP8X", [0x10, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16]);
  assert.deepEqual(imageSize(vp8x, "image/webp"), { w: 1600, h: 1067 });
  assert.equal(imageSize(riff("VP8L", [0x00, 0, 0, 0, 0]), "image/webp"), null, "bad VP8L signature");
});

test("imageSize: a JPEG whose EXIF says it is turned a quarter (orientation 5-8) gives the size it is shown at", () => {
  // APP1 "Exif\0\0", big-endian TIFF, IFD0 with one entry: Orientation (0x0112), SHORT, 1, value.
  const withOrientation = (v, le = false) => {
    const s16 = (n) => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
    const s32 = (n) => (le ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...s16(42), ...s32(8), ...s16(1), ...s16(0x0112), ...s16(3), ...s32(1), ...s16(v), 0, 0, ...s32(0)];
    const data = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const seg = [0xff, 0xe1, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
    return Uint8Array.from([0xff, 0xd8, ...seg, ...JPG.slice(2)]);
  };
  assert.deepEqual(imageSize(withOrientation(1), "image/jpeg"), { w: 3, h: 2 });
  assert.deepEqual(imageSize(withOrientation(3), "image/jpeg"), { w: 3, h: 2 }, "upside down: same size");
  assert.deepEqual(imageSize(withOrientation(6), "image/jpeg"), { w: 2, h: 3 });
  assert.deepEqual(imageSize(withOrientation(8, true), "image/jpeg"), { w: 2, h: 3 }, "little-endian EXIF");
  assert.deepEqual(imageSize(withOrientation(99), "image/jpeg"), { w: 3, h: 2 }, "nonsense orientation ignored");
});

// ---------------------------------------------------------------- copyPhotos

test("copyPhotos keeps /a.jpg as /s/f/<id> with its size and drops the other three with warnings and a todo", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const input = content([ph("/a.jpg", "New slate roof in Old Town"), ph("/big.jpg"), ph("/x.svg"), ph("/gone.jpg")]);
  const before = JSON.stringify(input);
  const { content: out, warnings } = await copyPhotos(DB, "c1", input, { fetchImpl, now: AT });

  assert.equal(JSON.stringify(input), before, "the content passed in isn't changed");
  assert.equal(out.photos.length, 1);
  const [photo] = out.photos;
  const id = FILE.exec(photo.url)?.[1];
  assert.match(photo.url, /^\/s\/f\/[0-9a-f]{32}$/);
  assert.equal(photo.w, 3);
  assert.equal(photo.h, 2);
  assert.equal(photo.alt, "New slate roof in Old Town");

  assert.equal(warnings.length, 3);
  assert.ok(warnings.includes("Photo https://old.site/big.jpg was 500 KB (limit 400 KB): add a smaller copy on the Site page."), warnings.join("\n"));
  assert.ok(warnings.some((w) => w.startsWith("Photo https://old.site/x.svg ")), "SVG refused");
  assert.ok(warnings.some((w) => w.startsWith("Photo https://old.site/gone.jpg ") && w.includes("404")), "404 named");

  // The kept photo is stored as a BLOB with its source.
  const row = DB.raw.prepare("SELECT * FROM site_files WHERE id = ?").get(id);
  assert.equal(row.client_id, "c1");
  assert.equal(row.kind, "photo");
  assert.equal(row.mime, "image/jpeg");
  assert.equal(row.size, 1000);
  assert.equal(row.bytes.length, 1000);
  assert.equal(row.width, 3);
  assert.equal(row.height, 2);
  assert.equal(row.source_url, "https://old.site/a.jpg");
  assert.equal(row.alt, "New slate roof in Old Town");
  assert.equal(row.created_at, "2026-10-28T10:00:00Z");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 1, "nothing else stored");

  // More than half failed → a build todo.
  const todo = DB.raw.prepare("SELECT * FROM todos WHERE dedupe = 'build:c1:photos'").get();
  assert.ok(todo, "todo build:c1:photos exists");
  assert.equal(todo.kind, "build");
  assert.equal(todo.title, "Add photos for Smith Roofing: 3 of their photos were too big or missing");
  assert.equal(todo.link, "/#/site/c1");
  assert.equal(todo.client_id, "c1");
  assert.equal(todo.place_id, "p1");
  assert.equal(todo.status, "open");

  // Each fetch had the 8-second timeout.
  assert.equal(calls.length, 4);
  for (const c of calls) assert.ok(c.init?.signal instanceof AbortSignal, c.url);

  // pages[].photo pointed at photos 0 (kept) and 1 (dropped): the first still points at it, the second has none.
  assert.equal(out.pages[0].photo, 0);
  assert.equal("photo" in out.pages[1], false);
});

test("copyPhotos: half or fewer failing adds no todo; a photo whose size can't be read is refused like a bad type", async () => {
  const DB = await seed();
  const { fetchImpl } = fakeFetch();
  const { content: out, warnings } = await copyPhotos(DB, "c1", content([ph("/a.jpg"), ph("/junk.jpg")]), { fetchImpl, now: AT });
  assert.equal(out.photos.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Photo https:\/\/old\.site\/junk\.jpg /);
  assert.match(warnings[0], /add a copy on the Site page\.$/);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 1, "the unreadable one isn't stored");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM todos").get().n, 0, "1 of 2 failed: not more than half");
});

test("copyPhotos fetches at most 12 for 20 photos", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const photos = Array.from({ length: 20 }, (_, i) => ph(`/p${i}.jpg`));
  const { content: out, warnings } = await copyPhotos(DB, "c1", content(photos), { fetchImpl, now: AT });
  assert.equal(MAX_FETCHES, 12);
  assert.ok(calls.length <= 12, `${calls.length} fetches`);
  assert.equal(calls.length, 12);
  assert.equal(out.photos.length, 12);
  assert.ok(out.photos.every((p) => FILE.test(p.url)));
  assert.equal(warnings.length, 8);
  assert.ok(warnings.every((w) => /at most 12/.test(w)), warnings[0]);
});

test("copyPhotos: 12 photos and a logo are 13 images: the logo takes a fetch slot first, the 12th photo waits", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const photos = Array.from({ length: 12 }, (_, i) => ph(`/p${i}.jpg`));
  const input = content(photos, { theme: { main: "#1e4f86", logo: "https://old.site/logo.png" } });
  const { content: out, warnings } = await copyPhotos(DB, "c1", input, { fetchImpl, now: AT });
  assert.equal(calls.length, 12);
  assert.ok(calls.some((c) => c.url === "https://old.site/logo.png"), "the logo was fetched");
  assert.match(out.theme.logo, FILE);
  assert.equal(out.photos.length, 11);
  assert.deepEqual(warnings, ["Photo https://old.site/p11.jpg wasn't copied: at most 12 photos are copied each time. Add it on the Site page."]);
  // The next post copies the one left over (the 12 copied before are reused, not fetched again).
  const again = await copyPhotos(DB, "c1", input, { fetchImpl, now: AT });
  assert.equal(calls.length, 13);
  assert.deepEqual(again.warnings, []);
  assert.equal(again.content.photos.length, 12);
});

test("copyPhotos: a body with no Content-Length that runs past 2 MB stops being read and says \"over 2 MB\"", async () => {
  const DB = await seed();
  let pulled = 0;
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(controller) {
      pulled += 100_000;
      controller.enqueue(new Uint8Array(100_000));
      if (pulled >= 50_000_000) controller.close();
    },
  }), { status: 200, headers: { "content-type": "image/jpeg" } });
  const { content: out, warnings } = await copyPhotos(DB, "c1", content([ph("/huge.jpg")]), { fetchImpl, now: AT });
  assert.equal(out.photos.length, 0);
  assert.deepEqual(warnings, ["Photo https://old.site/huge.jpg was over 2 MB (limit 400 KB): add a smaller copy on the Site page."]);
  assert.ok(pulled < 3_000_000, `${pulled} bytes read`);
});

test("copyPhotos: already-/s/f/ URLs aren't fetched and get their size from the stored file; a URL copied before is reused", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const first = await copyPhotos(DB, "c1", content([ph("/a.jpg")]), { fetchImpl, now: AT });
  const url = first.content.photos[0].url;
  assert.equal(calls.length, 1);

  // Claude posts again with the /s/f/ URL (no size) and the old URL again.
  const again = await copyPhotos(DB, "c1", content([{ url, alt: "Again" }, ph("/a.jpg", "Old URL again")]), { fetchImpl, now: AT });
  assert.equal(calls.length, 1, "no new fetch");
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.content.photos.map((p) => [p.url, p.w, p.h, p.alt]), [[url, 3, 2, "Again"], [url, 3, 2, "Old URL again"]]);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 1, "not stored twice");

  // Another client's file or an unknown one is dropped, never served on this site.
  const stranger = `/s/f/${"e".repeat(32)}`;
  const odd = await copyPhotos(DB, "c1", content([{ url: stranger, alt: "?" }]), { fetchImpl, now: AT });
  assert.equal(odd.content.photos.length, 0);
  assert.equal(odd.warnings.length, 1);
  assert.equal(calls.length, 1);
});

test("copyPhotos copies theme.logo too (kind logo, logo_w/logo_h), and WebP with a charset parameter", async () => {
  const DB = await seed();
  const { fetchImpl } = fakeFetch();
  const input = content([ph("/photo.webp")], { theme: { main: "#1e4f86", logo: "https://old.site/logo.png" } });
  const { content: out, warnings } = await copyPhotos(DB, "c1", input, { fetchImpl, now: AT });
  assert.deepEqual(warnings, []);
  assert.match(out.theme.logo, FILE);
  assert.equal(out.theme.logo_w, 3);
  assert.equal(out.theme.logo_h, 2);
  assert.equal(out.theme.main, "#1e4f86");
  const logo = DB.raw.prepare("SELECT kind, mime FROM site_files WHERE id = ?").get(FILE.exec(out.theme.logo)[1]);
  assert.deepEqual({ ...logo }, { kind: "logo", mime: "image/png" });
  const photo = DB.raw.prepare("SELECT kind, mime FROM site_files WHERE id = ?").get(FILE.exec(out.photos[0].url)[1]);
  assert.deepEqual({ ...photo }, { kind: "photo", mime: "image/webp" });
});

test("copyPhotos: a logo that fails is removed with a Logo warning; a declared Content-Length over the limit isn't read; a timeout is plain English", async () => {
  const DB = await seed();
  const { fetchImpl } = fakeFetch();
  const input = content([ph("/declared-big.jpg"), ph("/slow.jpg"), ph("/a.jpg")], { theme: { main: "#1e4f86", logo: "https://old.site/x.svg" } });
  const { content: out, warnings } = await copyPhotos(DB, "c1", input, { fetchImpl, now: AT });
  assert.equal(out.theme.logo, undefined);
  assert.equal(out.theme.logo_w, undefined);
  assert.ok(warnings.some((w) => w.startsWith("Logo https://old.site/x.svg ")), warnings.join("\n"));
  assert.ok(warnings.includes("Photo https://old.site/declared-big.jpg was 1.2 MB (limit 400 KB): add a smaller copy on the Site page."), warnings.join("\n"));
  assert.ok(warnings.some((w) => w.startsWith("Photo https://old.site/slow.jpg ") && /8 seconds/.test(w)), warnings.join("\n"));
  assert.equal(out.photos.length, 1);
  const todo = DB.raw.prepare("SELECT title FROM todos WHERE dedupe = 'build:c1:photos'").get();
  assert.equal(todo.title, "Add photos for Smith Roofing: 3 of their photos were too big or missing", "3 of 4 images failed");
});

test("copyPhotos: \"image/jpg\" (a common misnaming) is a JPEG, stored as image/jpeg; each fetch sends a browser user-agent", async () => {
  const DB = await seed();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return img(JPG, "image/jpg");
  };
  const { content: out, warnings } = await copyPhotos(DB, "c1", content([ph("/odd.jpg")]), { fetchImpl, now: AT });
  assert.deepEqual(warnings, []);
  const row = DB.raw.prepare("SELECT mime, width, height FROM site_files WHERE id = ?").get(FILE.exec(out.photos[0].url)[1]);
  assert.deepEqual({ ...row }, { mime: "image/jpeg", width: 3, height: 2 });
  assert.match(calls[0].headers["user-agent"], /^Mozilla\/5\.0 /);
  // SVG under any name is still refused.
  const svg = await copyPhotos(DB, "c1", content([ph("/x.svg")]), { fetchImpl: async () => img(new TextEncoder().encode("<svg/>"), "image/jpg"), now: AT });
  assert.equal(svg.content.photos.length, 0, "SVG bytes labelled image/jpg");
});

test("copyPhotos never fetches an http:// or non-URL photo (dropped with a warning)", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const { content: out, warnings } = await copyPhotos(DB, "c1", content([{ url: "http://old.site/a.jpg", alt: "x" }, { url: "javascript:alert(1)", alt: "x" }]), { fetchImpl, now: AT });
  assert.equal(calls.length, 0);
  assert.equal(out.photos.length, 0);
  assert.equal(warnings.length, 2);
});

// ---------------------------------------------------------------- serveFile

test("serveFile returns the bytes with content-type image/jpeg and a year-long immutable cache; unknown id → 404", async () => {
  const DB = await seed();
  const { fetchImpl } = fakeFetch();
  const { content: out } = await copyPhotos(DB, "c1", content([ph("/a.jpg")]), { fetchImpl, now: AT });
  const id = FILE.exec(out.photos[0].url)[1];

  const res = await serveFile(DB, id, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPG_1000);

  for (const bad of ["f".repeat(32), "nope", "", "../x", "A".repeat(32)]) {
    const miss = await serveFile(DB, bad, {});
    assert.equal(miss.status, 404, bad);
    assert.notEqual(miss.headers.get("cache-control"), "public, max-age=31536000, immutable", bad);
  }
});

test("serveFile uses the cache when one is given: a hit never reads D1, a miss reads D1 and puts it (key without the query)", async () => {
  const DB = await seed();
  const { fetchImpl } = fakeFetch();
  const { content: out } = await copyPhotos(DB, "c1", content([ph("/a.jpg")]), { fetchImpl, now: AT });
  const id = FILE.exec(out.photos[0].url)[1];

  const store = new Map();
  const cache = {
    async match(key) {
      const hit = store.get(typeof key === "string" ? key : key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key, res) {
      store.set(typeof key === "string" ? key : key.url, res);
    },
  };
  const first = await serveFile(DB, id, { cache, origin: "https://www.smithroofing.co.uk" });
  assert.equal(first.status, 200);
  assert.equal(store.size, 1);
  assert.equal([...store.keys()][0], `https://www.smithroofing.co.uk/s/f/${id}`);

  const noDb = { prepare() { throw new Error("D1 read on a cache hit"); } };
  const second = await serveFile(noDb, id, { cache, origin: "https://www.smithroofing.co.uk" });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), JPG_1000);

  // A 404 isn't cached; a broken cache never breaks serving.
  await serveFile(DB, "f".repeat(32), { cache });
  assert.equal(store.size, 1);
  const broken = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } };
  assert.equal((await serveFile(DB, id, { cache: broken })).status, 200);
});

// ---------------------------------------------------------------- saveUpload, deleteFile, listFiles

test("saveUpload: 400,001 bytes → the 'still over 400 KB' error; SVG and non-images refused; a PNG is stored", async () => {
  const DB = await seed();
  assert.equal(MAX_PHOTO_BYTES, 400_000);
  const big = new Uint8Array(400_001);
  big.set(PNG);
  assert.deepEqual(await saveUpload(DB, "c1", { bytes: big, mime: "image/png", alt: "x" }, AT),
    { ok: false, error: "That photo is still over 400 KB after shrinking. Try a smaller one." });

  const svg = await saveUpload(DB, "c1", { bytes: new TextEncoder().encode("<svg/>"), mime: "image/svg+xml", alt: "" }, AT);
  assert.equal(svg.ok, false);
  assert.match(svg.error, /JPEG, PNG, WebP or GIF/);
  const fake = await saveUpload(DB, "c1", { bytes: junk(500), mime: "image/png", alt: "" }, AT);
  assert.equal(fake.ok, false, "bytes that aren't a PNG");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 0);

  const ok = await saveUpload(DB, "c1", { bytes: PNG, mime: "image/png", alt: "  Finished\nroof  " }, AT);
  assert.equal(ok.ok, true);
  assert.match(ok.id, HEX32);
  const row = DB.raw.prepare("SELECT * FROM site_files WHERE id = ?").get(ok.id);
  assert.equal(row.kind, "photo");
  assert.equal(row.source_url, null);
  assert.equal(row.alt, "Finished roof");
  assert.equal(row.width, 3);
  assert.equal(row.height, 2);
  assert.equal(row.size, PNG.length);

  const files = await listFiles(DB, "c1");
  assert.deepEqual(files.map((f) => [f.id, f.kind, f.url, f.alt, f.width, f.height]), [[ok.id, "photo", `/s/f/${ok.id}`, "Finished roof", 3, 2]]);
  assert.equal("bytes" in files[0], false, "the list never carries the bytes");
});

test("deleteFile removes only this client's file, and refuses one the site's content still shows", async () => {
  const DB = await seed();
  const a = await saveUpload(DB, "c1", { bytes: PNG, mime: "image/png", alt: "a" }, AT);
  const b = await saveUpload(DB, "c1", { bytes: GIF, mime: "image/gif", alt: "b" }, AT);
  assert.deepEqual(await deleteFile(DB, "c2", a.id), { ok: false, status: 404, error: "That photo isn't there any more." });
  assert.deepEqual(await deleteFile(DB, "c1", a.id), { ok: true });
  assert.deepEqual(await deleteFile(DB, "c1", a.id), { ok: false, status: 404, error: "That photo isn't there any more." });

  await insert(DB, "client_sites", {
    client_id: "c1", slug: "smith-roofing-abcdef", created_at: T0, updated_at: T0,
    content: JSON.stringify({ photos: [{ url: `/s/f/${b.id}`, alt: "b" }] }),
  });
  const used = await deleteFile(DB, "c1", b.id);
  assert.equal(used.ok, false);
  assert.equal(used.status, 409);
  assert.match(used.error, /on the site/);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 1);
});

// ---------------------------------------------------------------- routes

const PASSWORD = "test-password-123";
const COOKIE = `cr_session=${createHmac("sha256", PASSWORD).update("goldbar-control-room-session").digest("hex")}`;

test("the photos route returns 401 without the login cookie (middleware), on every host", async () => {
  for (const host of ["goldbarwebsites.pages.dev", "control.aetoswebsites.com"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      let ran = 0;
      const request = new Request(`https://${host}/api/sites/c1/photos`, { method, body: method === "POST" ? PNG : undefined });
      const res = await middleware({ request, env: { CONTROL_ROOM_PASSWORD: PASSWORD, DB: fakeD1() }, next: async () => { ran++; return new Response("ran"); } });
      assert.equal(res.status, 401, `${method} ${host}`);
      assert.deepEqual(await res.json(), { error: "Not logged in" });
      assert.equal(ran, 0);
    }
  }
  // With the cookie it reaches the route.
  let ran = 0;
  const ok = await middleware({
    request: new Request("https://goldbarwebsites.pages.dev/api/sites/c1/photos", { headers: { cookie: COOKIE } }),
    env: { CONTROL_ROOM_PASSWORD: PASSWORD, DB: fakeD1() },
    next: async () => { ran++; return new Response("ran"); },
  });
  assert.equal(ok.status, 200);
  assert.equal(ran, 1);
});

test("photos route: POST a shrunk photo (multipart or raw), GET the list, DELETE one", async () => {
  const DB = await seed();
  const env = { DB };
  const params = { client_id: "c1" };
  const url = "https://goldbarwebsites.pages.dev/api/sites/c1/photos";

  const form = new FormData();
  form.set("photo", new Blob([WEBP], { type: "image/webp" }), "roof.webp");
  form.set("alt", "Ridge tiles replaced in Wroughton");
  const up = await photosRoute.onRequestPost({ request: new Request(url, { method: "POST", body: form }), env, params, now: AT });
  assert.equal(up.status, 200);
  const upBody = await up.json();
  assert.equal(upBody.ok, true);
  assert.match(upBody.id, HEX32);
  assert.equal(upBody.url, `/s/f/${upBody.id}`);
  assert.equal(upBody.width, 3);
  assert.equal(upBody.height, 2);

  const raw = await photosRoute.onRequestPost({
    request: new Request(`${url}?alt=${encodeURIComponent("Gutter")}`, { method: "POST", body: PNG, headers: { "content-type": "image/png" } }),
    env, params, now: AT,
  });
  assert.equal(raw.status, 200);
  const rawId = (await raw.json()).id;

  const tooBig = new Uint8Array(400_001);
  tooBig.set(PNG);
  const refused = await photosRoute.onRequestPost({ request: new Request(url, { method: "POST", body: tooBig, headers: { "content-type": "image/png" } }), env, params, now: AT });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { ok: false, error: "That photo is still over 400 KB after shrinking. Try a smaller one." });

  const svgForm = new FormData();
  svgForm.set("photo", new Blob(["<svg/>"], { type: "image/svg+xml" }), "x.svg");
  const svg = await photosRoute.onRequestPost({ request: new Request(url, { method: "POST", body: svgForm }), env, params, now: AT });
  assert.equal(svg.status, 400);

  const nobody = await photosRoute.onRequestPost({ request: new Request(url.replace("c1", "zz"), { method: "POST", body: PNG, headers: { "content-type": "image/png" } }), env, params: { client_id: "zz" }, now: AT });
  assert.equal(nobody.status, 404);
  assert.deepEqual(await nobody.json(), { error: "No client with that id." });

  const list = await photosRoute.onRequestGet({ request: new Request(url), env, params });
  assert.equal(list.status, 200);
  const { files } = await list.json();
  assert.deepEqual(files.map((f) => f.alt).sort(), ["Gutter", "Ridge tiles replaced in Wroughton"]);

  const del = await photosRoute.onRequestDelete({ request: new Request(`${url}?id=${rawId}`, { method: "DELETE" }), env, params });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  const gone = await photosRoute.onRequestDelete({ request: new Request(`${url}?id=${rawId}`, { method: "DELETE" }), env, params });
  assert.equal(gone.status, 404);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM site_files").get().n, 1);
});

test("/s/f/<id> route: GET serves the file, HEAD has no body, other methods are 405, unknown is 404", async () => {
  const DB = await seed();
  const { id } = await saveUpload(DB, "c1", { bytes: GIF, mime: "image/gif", alt: "" }, AT);
  const env = { DB };
  const get = await fileRoute.onRequest({ request: new Request(`https://aetoswebsites.com/s/f/${id}?v=1`), env, params: { id } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/gif");
  assert.equal(get.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), GIF);

  const head = await fileRoute.onRequest({ request: new Request(`https://aetoswebsites.com/s/f/${id}`, { method: "HEAD" }), env, params: { id } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "image/gif");
  assert.equal(await head.text(), "");

  const post = await fileRoute.onRequest({ request: new Request(`https://aetoswebsites.com/s/f/${id}`, { method: "POST", body: "x" }), env, params: { id } });
  assert.equal(post.status, 405);

  const miss = await fileRoute.onRequest({ request: new Request(`https://aetoswebsites.com/s/f/${"0".repeat(32)}`), env, params: { id: "0".repeat(32) } });
  assert.equal(miss.status, 404);

  // A cached photo is served without the database (not even bound); a miss with no database is the 503 below.
  const store = new Map();
  const had = globalThis.caches;
  globalThis.caches = { default: { match: async (k) => store.get(k)?.clone(), put: async (k, r) => void store.set(k, r) } };
  try {
    const fill = await fileRoute.onRequest({ request: new Request(`https://www.smithroofing.co.uk/s/f/${id}`), env, params: { id } });
    assert.equal(fill.status, 200);
    assert.equal(store.size, 1);
    const hit = await fileRoute.onRequest({ request: new Request(`https://www.smithroofing.co.uk/s/f/${id}?x=1`), env: {}, params: { id } });
    assert.equal(hit.status, 200);
    assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), GIF);
  } finally {
    if (had === undefined) delete globalThis.caches;
    else globalThis.caches = had;
  }

  // No database bound: a plain 503, not a crash.
  const down = await fileRoute.onRequest({ request: new Request(`https://aetoswebsites.com/s/f/${id}`), env: {}, params: { id } });
  assert.equal(down.status, 503);
});
