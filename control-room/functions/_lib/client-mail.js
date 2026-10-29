// Client emails: the welcome and payment-failed copy (pure, Part A of docs/rebuild/08-order-pay.md, exact), and
// sendClientMail, which every client email in stages 9–11 goes through (db).
//
// Client mail is plain text, kind `system`, author `system`, queued with queueMessage only. It goes from the active
// `system`-role mailbox; with none, from the active cold mailbox with the most room left today (system mail doesn't
// count against cold caps, so one with no room still sends) plus the `setup:system_mailbox` todo; with no active
// mailbox at all nothing is queued and a setup todo carries the whole email in its detail and the body as its draft
// (noMailboxTodo; null = no todo).
// Paused mailboxes are never used. Every sign-off is the business:sender_name setting (else "Nik"), never a mailbox's
// display_name.
import { mailboxCap } from "./mail/capacity.js";
import { queueMessage, sentToday } from "./mail/outbox.js";
import { formatPounds } from "./offer.js";
import { ukLongDate } from "./order-page.js";
import { getSetting } from "./settings.js";
import { addTodo, closeTodos } from "./todo.js";
import { ukDate } from "./ukTime.js";

const SENDER_NAME = "business:sender_name";
const DEFAULT_SIGN = "Nik";
const COMPANY = "Aetos Websites";

/** The no-mailbox todo for the welcome email (sendClientMail's default). `{name}` becomes the business name. */
export const WELCOME_TODO = Object.freeze({
  dedupe: "setup:welcome:<client_id>",
  title: "Send {name} their onboarding link yourself (no mailbox yet)",
});

const SYSTEM_MAILBOX_TODO = Object.freeze({
  kind: "setup",
  dedupe: "setup:system_mailbox",
  title: "Add a system mailbox for client emails (welcome emails are going from a cold mailbox)",
  link: "/#/setup",
});

/** One line of text: newlines and runs of spaces become one space (a name can't break a line or a header). */
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const greeting = (greetName) => {
  const name = oneLine(greetName);
  return name ? `Hi ${name},` : "Hi,";
};

const signOff = (signName) => `${oneLine(signName) || DEFAULT_SIGN}\n${COMPANY}`;

const isPence = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A plain http(s) web address, or null. (http is allowed so local wrangler dev works.) */
function webUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? text : null;
  } catch {
    return null;
  }
}

/** "Friday 18 December 2026", or null when the date isn't a real YYYY-MM-DD. */
function longDateOrNull(ymd) {
  try {
    return ukLongDate(ymd);
  } catch {
    return null;
  }
}

/**
 * The welcome email (Part A, exact). `terms` is termsFor(...) (PACKAGES.full | weekend | website); the Full Package
 * paragraph is there only when it has a monthly fee. amountPaid and the monthly fee are pence. firstChargeOn is the
 * UK date "YYYY-MM-DD" of the first monthly charge. So the email never breaks after a payment: a missing amount says
 * "Your payment has gone through.", and a missing or invalid firstChargeOn drops only the "The first £249 is taken
 * on …" sentence. An onboardUrl that isn't a web address throws (the email would be pointless without it).
 */
export function welcomeEmail({ business, greetName, terms, amountPaid, onboardUrl, firstChargeOn, signName } = {}) {
  const link = webUrl(onboardUrl);
  if (!link) throw new Error("welcomeEmail needs the onboarding link, a web address like https://aetoswebsites.com/onboard/<token>.");
  const name = oneLine(business);
  const paid = isPence(amountPaid) ? `Your payment of ${formatPounds(amountPaid)} has gone through.` : "Your payment has gone through.";
  const parts = [
    greeting(greetName),
    `Thanks for ordering. ${paid}`,
    "Next step: fill in this short form. It asks for your logo, photos, services and the areas you cover.",
    link,
    "Your 7 days start when the form is complete, and your website will be live within 7 days of that. GUARANTEED.",
  ];
  const monthly = Number(terms?.monthly) || 0;
  if (monthly > 0) {
    const when = longDateOrNull(firstChargeOn);
    const charge = when ? ` The first ${formatPounds(monthly)} is taken on ${when} from the card you used, then monthly.` : "";
    parts.push(`Your first ${Number(terms.freeDays) || 0} days of the monthly plan are free.${charge} You can stop any time by replying to this email.`);
  }
  parts.push("Any questions, just reply.", signOff(signName));
  return { subject: name ? `${name}: your onboarding form` : "Your onboarding form", body: parts.join("\n\n") };
}

/**
 * The payment-failed email (Part A, exact). amountDue is pence; payUrl is Stripe's hosted_invoice_url. Without a
 * web-address payUrl the "pay or change your card here" lines are left out (never a broken link); without an amount
 * or a business name those words are left out of the first sentence.
 */
export function paymentFailedEmail({ business, greetName, amountDue, payUrl, signName } = {}) {
  const name = oneLine(business);
  const amount = isPence(amountDue) && amountDue > 0 ? ` of ${formatPounds(amountDue)}` : "";
  const link = webUrl(payUrl);
  const parts = [
    greeting(greetName),
    `Your monthly payment${amount}${name ? ` for ${name}` : ""} didn't go through. This usually means a card has expired or been replaced.`,
  ];
  if (link) parts.push(`You can pay or change your card here:\n${link}`);
  parts.push(
    "Stripe will try the card again over the next few days. If you'd rather stop the monthly plan, just reply and I'll sort it. You keep your website either way.",
    `Thanks,\n${signOff(signName)}`,
  );
  return { subject: "Your Aetos Websites payment didn't go through", body: parts.join("\n\n") };
}

/**
 * The sign name for every client email: the business:sender_name setting on one line (trimmed, so a stray space or
 * line break can't spoil any caller's sign-off), else "Nik" (blank counts as unset).
 */
export async function senderName(DB) {
  return oneLine(await getSetting(DB, SENDER_NAME, "")) || DEFAULT_SIGN;
}

/**
 * The mailbox client mail goes from: the active `system` mailbox (lowest id when there are several), fallback
 * false; else the active cold mailbox with the most room left today (mailboxCap minus sentToday; ties by id, and one
 * with no room still counts, since client mail isn't capped), fallback true; else null. Paused mailboxes are ignored.
 * `now` is a Date or UTC ISO text.
 */
export async function systemMailbox(DB, now) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new TypeError("systemMailbox needs the time now, as a Date or UTC ISO text.");
  const { results } = await DB.prepare(
    `SELECT * FROM mailboxes WHERE status = 'active' AND role IN ('system', 'cold') ORDER BY id`,
  ).all();
  const system = results.find((m) => m.role === "system");
  if (system) return { mailbox: system, fallback: false };
  const cold = results.filter((m) => m.role === "cold");
  if (!cold.length) return null;
  const sent = await sentToday(DB, at);
  const today = ukDate(at);
  let best = null, bestRoom = -Infinity;
  for (const m of cold) {
    const room = mailboxCap(m, today) - (Number(sent[m.id]) || 0);
    if (room > bestRoom) {
      best = m;
      bestRoom = room;
    }
  }
  return { mailbox: best, fallback: true };
}

/**
 * Queue one client email. compose(signName) → {subject, body}, called with senderName(DB). Returns {queued: the
 * message id | null, fallback: whether it went from a cold mailbox}. `id` (optional) is the message's id, so a caller
 * that must queue an email once (the welcome email, `welcome:<client_id>`) gets D1's primary-key error ("UNIQUE
 * constraint failed: messages.id") when it is already there. With no active mailbox at all, nothing is queued and
 * the noMailboxTodo setup todo is filed with the whole email in its detail ("To: …", "Subject: …", a blank line, then
 * the body, so the onboarding or pay link shows on the Todo board, which shows a setup todo's detail) and the body
 * as its draft: `{name}` in its title becomes `business`, `<client_id>` in the default WELCOME_TODO's dedupe the
 * client id, and its link defaults to "/#/money". noMailboxTodo null files no todo. Callers other than the welcome
 * email must pass it (leaving it out files the welcome todo). Sent from the system mailbox, the setup:system_mailbox
 * todo (filed while client mail went from a cold one) closes. D1: at most 5 queries.
 */
export async function sendClientMail(DB, {
  id, client_id, place_id, to, business, compose, now, noMailboxTodo = WELCOME_TODO,
} = {}) {
  if (typeof compose !== "function") throw new TypeError("sendClientMail needs compose(signName) → {subject, body}.");
  const toAddr = typeof to === "string" ? to.trim() : "";
  if (!toAddr) throw new Error("sendClientMail needs the client's email address (to).");
  const todo = noMailboxTodo === null ? null : checkTodo(noMailboxTodo, client_id);
  const at = now ?? new Date();
  const [picked, signName] = await Promise.all([systemMailbox(DB, at), senderName(DB)]);
  const { subject, body } = compose(signName);

  if (!picked) {
    if (todo) {
      const name = oneLine(business) || "your new client";
      await addTodo(DB, {
        kind: "setup",
        dedupe: todo.dedupe,
        // A function, so a "$&" or "$'" in a business name is printed as written (not a replace() pattern).
        title: todo.title.replace("{name}", () => name),
        detail: `To: ${toAddr}\nSubject: ${subject ?? ""}\n\n${body}`,
        draft: body,
        client_id: client_id ?? null,
        place_id: place_id ?? null,
        link: todo.link ?? "/#/money",
      });
    }
    return { queued: null, fallback: false };
  }

  const { mailbox, fallback } = picked;
  const queued = await queueMessage(DB, {
    ...(id == null ? {} : { id: String(id) }),
    place_id: place_id ?? null,
    client_id: client_id ?? null,
    mailbox_id: mailbox.id,
    direction: "out",
    kind: "system",
    author: "system",
    to_addr: toAddr,
    from_addr: mailbox.address,
    subject,
    body,
    due_at: at,
  });
  // From a cold mailbox: ask Nik for a system one. From the system one: that todo has been done, so it closes.
  if (fallback) await addTodo(DB, SYSTEM_MAILBOX_TODO);
  else await closeTodos(DB, SYSTEM_MAILBOX_TODO.dedupe);
  return { queued, fallback };
}

/**
 * The no-mailbox todo, checked before anything is written: an object with a dedupe and a title (text). "<client_id>"
 * in its dedupe (the default WELCOME_TODO's) becomes the client id, which it then needs: without one every client's
 * todo would share a dedupe and all but the first would be swallowed.
 */
function checkTodo(todo, clientId) {
  const text = (v) => typeof v === "string" && v.trim() !== "";
  if (!todo || typeof todo !== "object" || !text(todo.dedupe) || !text(todo.title)) {
    throw new TypeError('sendClientMail: noMailboxTodo must be {dedupe, title, link?} (or null for no todo).');
  }
  if (todo.link != null && typeof todo.link !== "string") throw new TypeError("sendClientMail: noMailboxTodo.link must be text.");
  if (!todo.dedupe.includes("<client_id>")) return todo;
  const id = clientId == null ? "" : String(clientId).trim();
  if (!id) throw new Error("sendClientMail needs the client_id for the no-mailbox todo's dedupe.");
  return { ...todo, dedupe: todo.dedupe.replace("<client_id>", () => id) };
}
