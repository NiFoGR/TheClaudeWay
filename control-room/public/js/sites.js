// The Sites list (#/sites) and one client's Site page (#/site/<client_id>) (stage 10, docs/rebuild/09-build.md
// section 13, Part B Task 25). Routed in nav.js's routeFor, never a nav item: linked from every build todo, from
// Setup → "Client sites" and from stage 11's client page. The HTML comes from sitesview.js (pure, tested in
// tests/sites-page.test.mjs); this file fetches Task 24's JSON and wires the buttons:
//
// - Approve and put live (confirm), Build again, Ask Claude for changes, Take offline (confirm), Put back online:
//   POST /api/sites/<id>/approve | rebuild | changes {notes} | status {status: "off"|"on"}.
// - Domain: the address (POST …/domain {host}), each step's tick ({step, done}), the two nameservers ({nameservers}),
//   the client emails (GET …/send-domain-email?kind= to read and edit, then POST {kind, subject, body}) and Check now
//   (POST …/check).
// - Google Business Profile: "Invite accepted" first calls stage 11's access action (POST /api/care/<id> {action:
//   "access", on: <UK today>}, which starts the 90 days); stage 11 is built later, so until that route answers in JSON
//   the tick only closes the todo. Then POST …/domain {gbp, on}, which closes build:<id>:gbp.
// - Review booster: the link ({review_url}), Copy buttons, the per-client switch (POST …/feature).
// - Chatbot: the per-client switch (POST …/feature {feature: "chatbot", on}).
// - Photos: shrunk on this device (shrinkImage: canvas → WebP), POST …/photos as form-data; DELETE …/photos?id=.
//
// Every answer redraws the page from a fresh GET, so what Nik sees is what's stored. Errors are the server's own
// plain-English words, shown in the section the button is in.
import { api, esc, icon, modal, pageHead, toast, view } from "./lib.js";
import { siteView, sitesRows, ukToday } from "./sitesview.js";

const SUB = "Every client's website: what's waiting for you, the domain steps and the 7-day countdown.";
const OFFLINE_DOWN = "The Control Room didn't answer (check your internet connection). Try again.";

let visit = 0; // the newest page: a slow answer never replaces a newer one

// An error's words, plain: the server's sentence as it is, or what went wrong with the connection.
function reason(err) {
  if (err instanceof TypeError) return OFFLINE_DOWN;
  const text = String(err?.message ?? err ?? "").trim();
  if (!text || /^Request failed \(\d+\)$/.test(text)) return "That didn't work. Refresh the page; if it keeps happening, check the lights on Setup.";
  return text;
}

// ---------------------------------------------------------------- the list

/** The Sites list: one GET /api/sites; a row opens that client's Site page. */
export async function sitesPage() {
  const mine = ++visit;
  view.innerHTML = `${pageHead("Client sites", esc(SUB))}<div id="sites-body"><p class="muted">Loading the sites…</p></div>`;
  const el = document.getElementById("sites-body");
  const current = () => mine === visit && el.isConnected;
  let list;
  try {
    list = await api("/api/sites");
  } catch (err) {
    if (current()) el.innerHTML = `<p class="error">${esc(reason(err))}</p>`;
    return;
  }
  if (!current()) return;
  el.innerHTML = sitesRows(list);
  el.querySelectorAll("tr.click[data-href]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      location.hash = tr.dataset.href;
    });
  });
}

// ---------------------------------------------------------------- one site

/** One client's Site page (#/site/<client_id>). */
export async function sitePage(id) {
  const mine = ++visit;
  const clientId = String(id ?? "");
  view.innerHTML = `<div id="site-body"><p class="muted">Loading the site…</p></div>`;
  await draw(mine, clientId, false);
}

const base = (clientId) => `/api/sites/${encodeURIComponent(clientId)}`;

// Fetch and draw; `keep` keeps the scroll position (a redraw after a button). Returns the detail, or null.
async function draw(mine, clientId, keep) {
  const el = document.getElementById("site-body");
  if (!el) return null;
  let d;
  try {
    d = await api(base(clientId));
  } catch (err) {
    if (mine === visit && el.isConnected) {
      el.innerHTML = `${pageHead("Client site")}<p class="error">${esc(reason(err))}</p><p class="hint"><a href="#/sites">All client sites</a></p>`;
    }
    return null;
  }
  if (mine !== visit || !el.isConnected) return null;
  const y = window.scrollY;
  el.innerHTML = siteView(d);
  bind(el, d, mine, clientId);
  if (keep) window.scrollTo(0, y);
  return d;
}

// A message at the foot of one section (data-card): `error` in red, else a plain note.
function say(el, key, message, error = false) {
  const sec = el.querySelector(`[data-card="${key}"]`) || el.querySelector(".site-page") || el;
  sec.querySelector(".site-say")?.remove();
  if (!message) return;
  const p = document.createElement("p");
  p.className = `site-say ${error ? "error" : "hint"}`;
  p.setAttribute("role", error ? "alert" : "status");
  p.textContent = message;
  sec.append(p);
}

function bind(el, d, mine, clientId) {
  const name = d.name || d.form?.business?.name || "this client";
  const post = (path, body) => api(`${base(clientId)}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  const keyOf = (node) => node?.closest?.("[data-card]")?.dataset.card || "check";

  // Run `call`; on success redraw and show `ok` (text, or a function of the answer) in the same section; on failure
  // show the server's words there and run `undo` (e.g. put a checkbox back).
  async function run(node, call, ok, undo) {
    const key = keyOf(node);
    if (node && "disabled" in node) node.disabled = true;
    try {
      const out = await call();
      if (mine !== visit) return;
      const fresh = await draw(mine, clientId, true);
      const words = typeof ok === "function" ? ok(out) : ok;
      if (fresh && words) say(document.getElementById("site-body"), key, words);
    } catch (err) {
      if (mine !== visit) return;
      undo?.();
      if (node && "disabled" in node) node.disabled = false;
      say(el, key, reason(err), true);
    }
  }

  // ---- Check the site
  el.querySelector('[data-act="approve"]')?.addEventListener("click", (e) => {
    if (!confirm(`Put ${name}'s site live? It goes public as soon as their domain points at us.`)) return;
    run(e.currentTarget, () => post("/approve"), "Approved. It goes public as soon as the domain points at us.");
  });
  el.querySelector('[data-act="rebuild"]')?.addEventListener("click", (e) => {
    run(e.currentTarget, () => post("/rebuild"), "Claude is building it. It shows here, ready to approve, when it's done.");
  });
  el.querySelector('[data-act="offline"]')?.addEventListener("click", (e) => {
    if (!confirm(`Take ${name}'s site offline? Visitors will see 'This website isn't set up yet.'`)) return;
    run(e.currentTarget, () => post("/status", { status: "off" }), "Offline. Press Put back online to undo it.");
  });
  el.querySelector('[data-act="online"]')?.addEventListener("click", (e) => {
    run(e.currentTarget, () => post("/status", { status: "on" }), "Back online.");
  });
  el.querySelector('[data-form="changes"]')?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const notes = form.elements.notes.value.trim();
    if (!notes) return say(el, "check", "Tell Claude what to change.", true);
    run(form.querySelector("button[type=submit]"), () => post("/changes", { notes }), "Sent to Claude. The changes show here when Claude posts them.");
  });

  // ---- Domain
  el.querySelector('[data-form="host"]')?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    run(form.querySelector("button[type=submit]"), () => post("/domain", { host: form.elements.host.value.trim() }), "Saved.");
  });
  el.querySelector('[data-form="nameservers"]')?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const nameservers = [form.elements.ns1.value, form.elements.ns2.value].map((v) => v.trim()).filter(Boolean);
    run(form.querySelector("button[type=submit]"), () => post("/domain", { nameservers }), "Saved.");
  });
  el.querySelectorAll("input[data-step]").forEach((box) => {
    box.addEventListener("change", () => {
      const done = box.checked;
      run(box, () => post("/domain", { step: box.dataset.step, done }), "", () => { box.checked = !done; });
    });
  });
  el.querySelectorAll("[data-send-email]").forEach((btn) => {
    btn.addEventListener("click", () => openEmail(btn, btn.dataset.sendEmail));
  });
  el.querySelector('[data-act="check"]')?.addEventListener("click", (e) => {
    run(e.currentTarget, () => post("/check"), (r) => r?.detail || "Checked.");
  });

  async function openEmail(btn, kind) {
    btn.disabled = true;
    let mail;
    try {
      mail = await api(`${base(clientId)}/send-domain-email?kind=${encodeURIComponent(kind)}`);
    } catch (err) {
      btn.disabled = false;
      return say(el, "domain", reason(err), true);
    }
    btn.disabled = false;
    if (mine !== visit) return;
    const dlg = modal(`<form><div class="modal-head"><h2>Email to ${esc(name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
  <div class="modal-body">
    <p class="hint" style="margin:0">To: ${esc(mail.to || "")} · from the system mailbox. Change anything you like first.</p>
    <div><label for="se-subject">Subject</label><input id="se-subject" maxlength="200" value="${esc(mail.subject || "")}"></div>
    <div><label for="se-body">Email</label><textarea id="se-body" rows="14">${esc(mail.body || "")}</textarea></div>
    <p class="error" hidden></p>
  </div>
  <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send</button></div></form>`);
    const form = dlg.querySelector("form");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = dlg.querySelector(".error");
      const send = form.querySelector("button[type=submit]");
      send.disabled = true;
      err.hidden = true;
      try {
        const out = await post("/send-domain-email", { kind, subject: dlg.querySelector("#se-subject").value, body: dlg.querySelector("#se-body").value });
        dlg.close();
        if (mine !== visit) return;
        const fresh = await draw(mine, clientId, true);
        if (fresh) say(document.getElementById("site-body"), "domain", out?.message || "Done.");
      } catch (x) {
        err.textContent = reason(x);
        err.hidden = false;
        send.disabled = false;
      }
    };
  }

  // ---- Google Business Profile
  el.querySelectorAll("input[data-gbp]").forEach((box) => {
    box.addEventListener("change", () => {
      const which = box.dataset.gbp;
      const on = box.checked;
      let care = null;
      run(box, async () => {
        if (which === "invite_accepted" && on) care = await careAccess(clientId);
        return post("/domain", { gbp: which, on });
      }, () => (!on ? "" : care?.shipped ? "Ticked: the 90 days start today." : "Ticked: the todo is closed."), () => { box.checked = !on; });
    });
  });

  // ---- Review booster and Chatbot switches, Copy buttons
  el.querySelector('[data-form="review"]')?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    run(form.querySelector("button[type=submit]"), () => post("/domain", { review_url: form.elements.review_url.value.trim() }), "Saved.");
  });
  el.querySelectorAll("input[data-feature]").forEach((box) => {
    box.addEventListener("change", () => {
      const on = box.checked;
      run(box, () => post("/feature", { feature: box.dataset.feature, on }), on ? "Switched on." : "Switched off.", () => { box.checked = !on; });
    });
  });
  el.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = el.querySelector(`[data-copy-text="${btn.dataset.copy}"]`)?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied.");
      } catch {
        prompt("Copy this:", text);
      }
    });
  });

  // ---- Photos
  el.querySelector("[data-add-photos]")?.addEventListener("change", async (e) => {
    const input = e.currentTarget;
    const files = [...(input.files || [])];
    if (!files.length) return;
    const alt = el.querySelector("[data-photo-alt]")?.value.trim() || "";
    input.disabled = true;
    say(el, "photos", `Adding ${files.length === 1 ? "the photo" : `${files.length} photos`}…`);
    const problems = [];
    let added = 0;
    for (const file of files) {
      try {
        await uploadPhoto(clientId, await shrinkImage(file), alt);
        added++;
      } catch (err) {
        problems.push(`${file.name}: ${reason(err)}`);
      }
    }
    if (mine !== visit) return;
    const fresh = await draw(mine, clientId, true);
    const done = added ? `Added ${added === 1 ? "1 photo" : `${added} photos`}.` : "";
    if (fresh) say(document.getElementById("site-body"), "photos", [done, ...problems].filter(Boolean).join(" "), problems.length > 0);
  });
  el.querySelectorAll("[data-del-photo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this photo?")) return;
      run(btn, () => api(`${base(clientId)}/photos?id=${encodeURIComponent(btn.dataset.delPhoto)}`, { method: "DELETE" }), "Deleted.");
    });
  });
}

/**
 * Stage 11's access action: POST /api/care/<id> {action: "access", on: <UK today>} sets care.gbp_access_on, day 0 of
 * the 90-day guarantee. An answer that isn't JSON means the route isn't there yet (stage 11 is built after this
 * stage): nothing to do, the tick then only closes the todo. A JSON error is the API's own words (thrown).
 */
async function careAccess(clientId) {
  const resp = await fetch(`/api/care/${encodeURIComponent(clientId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "access", on: ukToday() }),
  });
  if (resp.status === 401) {
    location.href = "/login";
    throw new Error("Not logged in");
  }
  if (!/application\/json/i.test(resp.headers.get("content-type") || "")) return { shipped: false };
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${resp.status})`);
  return { shipped: true };
}

// One photo as form-data (`photo` + `alt`): the server checks the size (400 KB), the type and the 12-photo limit.
async function uploadPhoto(clientId, blob, alt) {
  const form = new FormData();
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : "jpg";
  form.append("photo", blob, `photo.${ext}`);
  form.append("alt", alt);
  const resp = await fetch(`${base(clientId)}/photos`, { method: "POST", body: form });
  if (resp.status === 401) {
    location.href = "/login";
    throw new Error("Not logged in");
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data;
}

const toBlobAs = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * A photo made smaller on this device before upload: at most `maxWidth` pixels wide, re-encoded as WebP at `quality`
 * (JPEG where the browser can't write WebP). A GIF is sent as it is (re-encoding would lose its animation). If it is
 * still over 400 KB, the quality steps down a little; the server refuses anything still too big. Browser only.
 */
export async function shrinkImage(file, maxWidth = 1600, quality = 0.8) {
  if (file.type === "image/gif") return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't a photo this browser can open. Try a JPEG or PNG."));
      i.src = url;
    });
    const scale = Math.min(1, maxWidth / (img.naturalWidth || maxWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = quality;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", q));
    const type = blob?.type === "image/webp" ? "image/webp" : "image/jpeg";
    if (type !== "image/webp") {
      // JPEG has no transparency: a PNG's clear parts would turn black, so they go white instead.
      const ctx = canvas.getContext("2d");
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
      blob = await toBlobAs(canvas, type, q);
    }
    while (blob && blob.size > 400_000 && q > 0.45) {
      q = Math.round((q - 0.1) * 100) / 100;
      blob = await toBlobAs(canvas, type, q);
    }
    if (!blob) throw new Error("This browser couldn't shrink that photo. Try another one.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
