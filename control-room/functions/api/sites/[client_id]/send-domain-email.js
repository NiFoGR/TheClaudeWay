// The domain-step emails to the client (stage 10, docs/rebuild/09-build.md sections 7 and 12, Task 24), behind the
// login: case B's nameserver steps (kind "nameservers") and case C's "point www at us" (kind "cname").
//   GET  /api/sites/<client_id>/send-domain-email?kind=… → {kind, to, subject, body}: the email as it would go, for
//        Nik to read and edit first.
//   POST /api/sites/<client_id>/send-domain-email {kind?, subject?, body?} → queues it through stage 9's
//        sendClientMail (system mailbox; kind defaults to the plan's mode). Nik's edited subject (one line) and body
//        replace the composed ones. Queued → the step (ns_email / cname_email) is ticked and its todo closes. With no
//        mailbox at all nothing is queued: the todo setup:client-mail:<client_id>:domain-nameservers|domain-cname
//        ("Send {name} this email yourself (no mailbox yet)") carries the email as its draft, and the step stays for
//        Nik to tick once he has sent it. → {ok: true, queued: message id | null, todo: dedupe | null, message}.
// 400 in plain English when the email can't be written (no nameservers yet, no domain, no address to send to);
// 404 for an unknown client. Tested in control-room/tests/sites-api.test.mjs.
import { senderName, sendClientMail } from "../../../_lib/client-mail.js";
import { cnameEmail, nameserverEmail, oneLine } from "../../../_lib/sites/copy.js";
import { updateDomain } from "../../../_lib/sites/db.js";
import { bad, db, iso, json } from "../../../_lib/util.js";
import { clientIdOf, closeTodo, loadSite, NO_CLIENT, NOT_JSON, nowOf, readBody, siteDomain } from "../[client_id].js";

const KINDS = { nameservers: "ns_email", cname: "cname_email" };
const PICK = "Pick which email to send: nameservers or cname.";
const BODY_MAX = 20_000;
const TOO_LONG = "That email is over 20,000 characters: shorten it.";
const QUEUED = "Queued: it goes from the system mailbox within 5 minutes.";
const NO_MAILBOX = "There's no mailbox yet, so it's on your Todo board for you to send yourself.";

const noAddress = (name) =>
  `We don't have an email address for ${name} yet: it comes from their payment or their onboarding form. Send it yourself for now.`;

/** The kind asked for, else the plan's mode when that has an email; null when neither. */
function kindOf(asked, site) {
  const k = typeof asked === "string" && asked ? asked : site.domain?.mode;
  return Object.hasOwn(KINDS, k) ? k : null;
}

/** compose(nik) → {subject, body} for this site and kind. Throws a plain-English Error when it can't be written. */
function composer(site, kind) {
  const d = site.domain ?? {};
  const f = site.form ?? {};
  const common = { first: site.first, domain: siteDomain(site), registrar: d.registrar ?? f.domain?.registrar };
  return kind === "nameservers"
    ? (nik) => nameserverEmail({ ...common, ns: d.nameservers, emailOnIt: d.email_on_it ?? f.domain?.email_on_it, nik })
    : (nik) => cnameEmail({ ...common, pagesHost: site.pages_host, nik });
}

/** The site, its kind and the composed email, or {error, status}. */
async function prepare(DB, context, askedKind) {
  const site = await loadSite(DB, clientIdOf(context.params));
  if (!site) return { error: NO_CLIENT, status: 404 };
  const kind = kindOf(askedKind, site);
  if (!kind) return { error: PICK, status: 400 };
  const compose = composer(site, kind);
  try {
    compose("Nik"); // the sign name changes nothing but the last line: this only checks it can be written
  } catch (err) {
    return { error: String(err?.message ?? err), status: 400 };
  }
  const name = oneLine(site.name) || "this client";
  if (!site.email_to) return { error: noAddress(name), status: 400 };
  return { site, kind, compose, name };
}

export async function onRequestGet(context) {
  const DB = await db(context.env);
  const kind = new URL(context.request.url).searchParams.get("kind");
  const p = await prepare(DB, context, kind);
  if (p.error) return bad(p.error, p.status);
  const email = p.compose(await senderName(DB));
  return json({ kind: p.kind, to: p.site.email_to, subject: email.subject, body: email.body });
}

export async function onRequestPost(context) {
  const now = nowOf(context);
  const body = await readBody(context.request);
  if (!body) return bad(NOT_JSON);
  const DB = await db(context.env);
  const p = await prepare(DB, context, body.kind);
  if (p.error) return bad(p.error, p.status);
  const { site, kind, name } = p;
  const id = site.client_id;

  // Nik's edits, if any: the subject on one line (it goes into a header), the body as typed.
  const editedBody = typeof body.body === "string" ? body.body.replace(/\r\n?/g, "\n").trim() : "";
  if (editedBody.length > BODY_MAX) return bad(TOO_LONG);
  const editedSubject = typeof body.subject === "string" ? oneLine(body.subject) : "";
  const compose = (nik) => {
    const email = p.compose(nik);
    return { subject: editedSubject || email.subject, body: editedBody || email.body };
  };

  const dedupe = `setup:client-mail:${id}:domain-${kind}`;
  const { queued } = await sendClientMail(DB, {
    client_id: id,
    place_id: site.place_id ?? null,
    to: site.email_to,
    business: name,
    now,
    compose,
    noMailboxTodo: { dedupe, title: "Send {name} this email yourself (no mailbox yet)", link: `/#/site/${id}` },
  });
  if (queued) {
    const step = KINDS[kind];
    await updateDomain(DB, id, { steps: { [step]: iso(now) } }, now);
    await closeTodo(DB, `build:${id}:domain:${step}`);
    await closeTodo(DB, dedupe); // a "send it yourself" todo from before the mailbox existed is done now
  }
  return json({ ok: true, queued: queued ?? null, todo: queued ? null : dedupe, message: queued ? QUEUED : NO_MAILBOX });
}
