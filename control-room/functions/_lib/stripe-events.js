// What each Stripe webhook event does to the database. Pure-ish: takes D1 + the event, so it's testable.
//
// fulfilCheckout (Part A of docs/rebuild/08-order-pay.md, "What a paid checkout does") turns a paid Checkout Session
// into a client, their Stripe links, the build payment, an onboarding row and the welcome email. The webhook and the
// thanks page both run it, so it is idempotent: the client id comes from the session id, every insert is OR IGNORE
// (or keyed), the welcome email has a fixed id (`welcome:<client_id>`) and is queued by whichever run finds it
// missing, and the `ordered` event is stored once per demo. `leads` is never written here (the scraper owns it).
import { latestDemo, recordEvent, DEMO_BASE } from "./demo-db.js";
import { stopFollowups } from "./followups.js";
import { applyStageEvent } from "./prospects.js";
import { handOffWaiting } from "./replies-db.js";
import { paymentFailedEmail, sendClientMail, welcomeEmail } from "./client-mail.js";
import { formatPounds, termsFor } from "./offer.js";
import { beat } from "./routines.js";
import { invoiceSubscription, stripeApi, stripeKey, verifySignature, webhookSecret } from "./stripe.js";
import { addTodo, closeLeadTodos } from "./todo.js";
import { addUkDays, ukDate } from "./ukTime.js";
import { iso } from "./util.js";

async function clientForCustomer(DB, customer) {
  return customer ? DB.prepare("SELECT client_id FROM client_links WHERE stripe_customer = ?").bind(customer).first() : null;
}

const PAID = ["paid", "no_payment_required"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const NAME_MAX = 120;

// A Stripe id field that may come expanded ({id, ...}) when the thanks page fetched the session.
const stripeId = (value) => {
  const id = value && typeof value === "object" ? value.id : value;
  return typeof id === "string" && id ? id : null;
};

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The package a session paid for: {pkg: "full" | "website", weekend}, or null when it isn't one of ours. Our checkout
 * sets metadata.package and metadata.weekend; legacy payment links set metadata.aetos_package (goldbar_package before
 * the rename) to full, weekend or website.
 */
function sessionPackage(metadata) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  if (m.package === "full" || m.package === "website") return { pkg: m.package, weekend: m.package === "full" && m.weekend === "1" };
  const legacy = m.aetos_package ?? m.goldbar_package;
  if (legacy === "full" || legacy === "website") return { pkg: legacy, weekend: false };
  if (legacy === "weekend") return { pkg: "full", weekend: true };
  return null;
}

// The origin the onboarding link uses: the host they ordered on (metadata.origin), else the public site.
function onboardOrigin(origin) {
  try {
    const url = new URL(text(origin));
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch { /* not a web address */ }
  return DEMO_BASE;
}

// 24 random bytes as base64url without padding: 32 characters.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Whether the welcome email has been dealt with: queued (its fixed id) or handed to Nik as the no-mailbox todo (still
// held, or freed by closeTodos as "<dedupe>@<done_at>"; the range reads through the dedupe index). ?1 message id,
// ?2 the todo's dedupe.
const WELCOME_DONE_SQL = `SELECT EXISTS (SELECT 1 FROM messages WHERE id = ?1)
    OR EXISTS (SELECT 1 FROM todos WHERE dedupe = ?2 OR (dedupe > ?2 || '@' AND dedupe < ?2 || 'A')) AS done`;
const ALREADY_QUEUED_RE = /UNIQUE constraint failed: messages\.id/;

const toDate = (value) => {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new TypeError("fulfilCheckout needs the time now, as a Date or UTC ISO text.");
  return d;
};

/**
 * A paid Checkout Session becomes a client, once (Part A's 9 steps, in order, except that the onboarding row (step 5)
 * is made after steps 6–7, right before the welcome email). Returns {status: "ok", client_id, token, created, terms,
 * amountPaid, firstChargeOn, place_id}; `created` is true for the run that queued the welcome email (or filed it as
 * Nik's no-mailbox todo). Not paid, or not one of our packages → {status: "ignored", reason} and nothing is written.
 * Every step runs every time and is idempotent, so a run cut off half way (a D1 error anywhere, the welcome email's
 * insert included) is finished by the next: the onboarding token is made once and never changes (a link already
 * shown stays valid), the welcome email is queued by whichever run finds it missing (`welcome:<client_id>`; a racing
 * runner's primary-key error is "already queued"), and the `ordered` event is stored once per demo. Step 8 (closing
 * the lead's sales todos, filing "New client: … onboarding form sent") runs only while onboarding.status is 'sent'
 * (the form not yet submitted), so a thanks-page reload or a late Stripe redelivery after stage 10 has closed that
 * todo doesn't file it again.
 */
export async function fulfilCheckout(DB, session, { now: at } = {}) {
  const nowDate = toDate(at);
  const s = session && typeof session === "object" ? session : {};
  const ignored = (reason) => ({
    status: "ignored", reason, client_id: null, token: null, created: false, terms: null, amountPaid: 0,
    firstChargeOn: null, place_id: null,
  });
  if (!PAID.includes(s.payment_status)) return ignored(`not paid (${String(s.payment_status ?? "no status").slice(0, 40)})`);
  const bought = sessionPackage(s.metadata);
  if (!bought) return ignored("not an Aetos order");
  if (typeof s.id !== "string" || !s.id) return ignored("no session id");

  // 1. one client per session, whoever runs it
  const client_id = `cl_${s.id}`;
  const terms = termsFor(bought.pkg, bought.weekend);
  const customer = stripeId(s.customer);
  const subscription = terms.monthly > 0 ? stripeId(s.subscription) : null;
  const email = text(s.customer_details?.email) || text(s.customer_email);
  const phone = text(s.customer_details?.phone);
  const amountPaid = Number.isSafeInteger(s.amount_total) && s.amount_total > 0 ? s.amount_total : 0;
  const createdAt = Number.isFinite(s.created) ? new Date(s.created * 1000) : nowDate;
  const paidOn = ukDate(createdAt);
  const firstChargeOn = terms.monthly > 0 ? addUkDays(paidOn, terms.freeDays) : null;
  const stamp = iso(nowDate);

  const wanted = text(s.metadata?.place_id) || text(s.client_reference_id);
  const lead = wanted ? await DB.prepare("SELECT place_id, name FROM leads WHERE place_id = ?").bind(wanted).first() : null;
  const place_id = lead?.place_id ?? null;
  const legacyBusiness = (Array.isArray(s.custom_fields) ? s.custom_fields : []).find((f) => f?.key === "business")?.text?.value;
  const name = (text(lead?.name) || text(legacyBusiness) || text(s.customer_details?.name) || email || "New client").slice(0, NAME_MAX);

  // 2–4. the client, their Stripe links and the build payment, together
  const stmts = [
    DB.prepare(`INSERT OR IGNORE INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(client_id, name, place_id, terms.key, amountPaid, terms.monthly, terms.freeDays, paidOn,
        [email, phone].filter(Boolean).join(" · "), stamp),
  ];
  if (customer) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO client_links (client_id, stripe_customer, stripe_subscription, email)
                           VALUES (?, ?, ?, ?)`).bind(client_id, customer, subscription, email || null));
    // invoice.paid writes the same id for the build line, so whichever comes first there is one row; this fixes its name
    if (amountPaid > 0) {
      stmts.push(DB.prepare(`INSERT INTO payments (id, stripe_customer, name, category, amount_pence, paid_on, created_at)
                             VALUES (?, ?, ?, 'Website builds', ?, ?, ?)
                             ON CONFLICT(id) DO UPDATE SET name = excluded.name`)
        .bind(`build:${customer}`, customer, name, amountPaid, paidOn, stamp));
    }
  }
  await DB.batch(stmts);

  let greetName = null;
  if (place_id) {
    // 6. the prospect is won (a lost one too: money beats a "no"); no row → one is made with the checkout email
    await applyStageEvent(DB, place_id, "paid", nowDate, { email: EMAIL_RE.test(email) ? email : null, greet_name: null });
    await stopFollowups(DB, place_id, "paid", nowDate);
    await handOffWaiting(DB, place_id, nowDate); // Claude never answers a client: their waiting mail goes to Nik
    greetName = (await DB.prepare("SELECT greet_name FROM prospects WHERE place_id = ?").bind(place_id).first())?.greet_name ?? null;
  }
  // 7. a past "no thanks" can't block client mail
  if (email) await DB.prepare("DELETE FROM suppression WHERE kind = 'email' AND value = ?").bind(email.toLowerCase()).run();

  // 5. the onboarding row, made once (its token never changes). Then the welcome email, on every run until it has
  // been queued or handed to Nik, so a run that fails anywhere (the email's own insert included) is finished by the
  // retry (Stripe resends after a 500), or by the webhook after a thanks page that failed.
  await DB.prepare("INSERT OR IGNORE INTO onboarding (client_id, token, status, created_at) VALUES (?, ?, 'sent', ?)")
    .bind(client_id, newToken(), stamp).run();
  const onboarding = await DB.prepare("SELECT token, status FROM onboarding WHERE client_id = ?").bind(client_id).first();
  const token = onboarding?.token ?? null;

  let created = false;
  const welcomeId = `welcome:${client_id}`;
  if (email && token
    && !(await DB.prepare(WELCOME_DONE_SQL).bind(welcomeId, `setup:welcome:${client_id}`).first())?.done) {
    const onboardUrl = `${onboardOrigin(s.metadata?.origin)}/onboard/${token}`;
    try {
      await sendClientMail(DB, {
        id: welcomeId, client_id, place_id, to: email, business: name, now: nowDate,
        compose: (signName) => welcomeEmail({
          business: name, greetName, terms, amountPaid: amountPaid || undefined, onboardUrl, firstChargeOn, signName,
        }),
      });
      created = true;
    } catch (err) {
      // Another runner (the webhook and the thanks page arrive together) queued it between our check and our insert.
      // Anything else is a real failure: rethrown, so the webhook answers 500 and Stripe retries.
      if (!ALREADY_QUEUED_RE.test(String(err?.message ?? err))) throw err;
    }
  }
  if (place_id) {
    const slug = text(s.metadata?.slug);
    const row = slug ? await DB.prepare("SELECT * FROM demos WHERE slug = ? AND place_id = ?").bind(slug, place_id).first() : null;
    const demo = row ?? await latestDemo(DB, place_id);
    // a win for the email version that brought them in; stored once per demo, so every run may try
    if (demo) await recordEvent(DB, demo, "ordered", nowDate);
  }

  // 8. while the form isn't in yet: the lead's sales todos are done (Nik's open conversations and calls stay: a booked
  // call becomes a welcome call, and a question they asked still needs his answer); Nik's todo for the new client.
  // Once stage 10 moves onboarding past 'sent' (and closes build:new:<client_id>), a re-run changes nothing here.
  if (onboarding?.status === "sent") {
    if (place_id) await closeLeadTodos(DB, place_id, { exceptKinds: ["build", "payment", "escalation", "call_time", "call"] });
    await addTodo(DB, {
      kind: "build", dedupe: `build:new:${client_id}`, title: `New client: ${name} — onboarding form sent`,
      link: "/#/money", place_id, client_id,
    });
  }

  // 9. they already were a (still paying) client: the money was taken twice. Only a client made before this one counts,
  // so of two sessions for one lead only the later files the todo, however often either is run again.
  if (place_id) {
    const other = await DB.prepare(`SELECT 1 AS yes FROM clients AS o JOIN clients AS me ON me.id = ?2
      WHERE o.place_id = ?1 AND o.id <> me.id AND o.cancelled_on IS NULL
        AND (o.created_at < me.created_at OR (o.created_at = me.created_at AND o.id < me.id)) LIMIT 1`)
      .bind(place_id, client_id).first();
    if (other) {
      await addTodo(DB, {
        kind: "payment", dedupe: `payment:double:${place_id}:${s.id}`, title: `${name} paid twice: refund one in Stripe`,
        link: "/#/money", place_id, client_id,
      });
    }
  }

  return { status: "ok", client_id, token, created, terms, amountPaid, firstChargeOn, place_id };
}

// The client an invoice belongs to: by its customer, else by its subscription (either payload shape).
async function linkForInvoice(DB, inv) {
  const customer = stripeId(inv.customer);
  if (customer) {
    const link = await DB.prepare("SELECT client_id, stripe_customer FROM client_links WHERE stripe_customer = ?").bind(customer).first();
    if (link) return link;
  }
  const sub = invoiceSubscription(inv);
  return sub ? DB.prepare("SELECT client_id, stripe_customer FROM client_links WHERE stripe_subscription = ?").bind(sub).first() : null;
}

const isSubscriptionLine = (line) => line?.type === "subscription" || line?.parent?.type === "subscription_item_details";
const pence = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

// Stripe's fee on the invoice's charge (from its balance transaction); 0 when there's no charge or Stripe can't say.
async function chargeFee(DB, env, chargeId, fetchImpl) {
  if (!chargeId) return 0;
  try {
    const key = (await stripeKey(env, DB))?.key;
    const charge = await stripeApi(key, "GET", `charges/${encodeURIComponent(chargeId)}?expand[]=balance_transaction`, null, fetchImpl);
    return pence(charge?.balance_transaction?.fee);
  } catch {
    return 0; // the payment still counts; only the fee is missing
  }
}

/**
 * Money actually received on an invoice: the build fee (its one-off lines, id `build:<customer>`, the same row
 * fulfilCheckout writes) and/or a monthly payment (`<invoice id>:monthly`). Stripe's fee is split pro rata. A repeat
 * only refreshes the fee, so whichever of the invoice and the checkout arrives first, there is one build row.
 */
async function invoicePaid(DB, env, inv, { now: at, fetchImpl }) {
  const paid = pence(inv.amount_paid);
  if (!paid) return "nothing paid (free trial invoice)";
  if (typeof inv.id !== "string" || !inv.id) return "ignored: invoice has no id";
  const link = await linkForInvoice(DB, inv);
  const customer = stripeId(inv.customer) || link?.stripe_customer || null;

  const parts = { build: 0, monthly: 0 };
  for (const line of inv.lines?.data || []) parts[isSubscriptionLine(line) ? "monthly" : "build"] += pence(line?.amount);
  if (!parts.build && !parts.monthly) parts[invoiceSubscription(inv) && inv.billing_reason !== "subscription_create" ? "monthly" : "build"] = paid;
  if (parts.build && !customer) return "ignored: a build payment with no Stripe customer"; // its id needs one

  const fee = await chargeFee(DB, env, stripeId(inv.charge), fetchImpl);
  const total = parts.build + parts.monthly;
  // pro rata, the remainder on the last part, so the rows add up to exactly what Stripe took
  const share = (part, of) => Math.round((part / total) * of);
  const amounts = parts.build && parts.monthly
    ? { build: [share(parts.build, paid), share(parts.build, fee)], monthly: [paid - share(parts.build, paid), fee - share(parts.build, fee)] }
    : { [parts.build ? "build" : "monthly"]: [paid, fee] };

  const client = link ? await DB.prepare("SELECT name FROM clients WHERE id = ?").bind(link.client_id).first() : null;
  const name = text(client?.name) || text(inv.customer_name) || text(inv.customer_email) || "Stripe payment";
  const paidAt = inv.status_transitions?.paid_at || inv.created;
  const paidOn = ukDate(Number.isFinite(paidAt) ? new Date(paidAt * 1000) : at);
  const stamp = iso(at);
  const stmts = Object.entries(amounts).map(([part, [amount, partFee]]) =>
    DB.prepare(`INSERT INTO payments (id, stripe_customer, name, category, amount_pence, fee_pence, paid_on, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET fee_pence = excluded.fee_pence`)
      .bind(part === "build" ? `build:${customer}` : `${inv.id}:monthly`, customer, name,
        part === "build" ? "Website builds" : "Monthly retainers", amount, partFee, paidOn, stamp));
  if (link) stmts.push(DB.prepare("UPDATE client_links SET failed_on = NULL WHERE client_id = ?").bind(link.client_id));
  await DB.batch(stmts);
  return `recorded ${formatPounds(paid)} from ${name}`;
}

// The UK date of a Stripe unix time, else of `fallback` (the time the event arrived).
const ukDay = (unixSeconds, fallback) => ukDate(Number.isFinite(unixSeconds) && unixSeconds > 0 ? new Date(unixSeconds * 1000) : fallback);

/**
 * A card failed on a monthly invoice (known clients only). failed_on is set; the `payment` todo is filed once per
 * invoice, and only the run that filed it emails the client a link to pay, so Stripe's retries (new events for the
 * same invoice) never email them twice. With no mailbox at all, Nik gets the email as a setup todo instead. An
 * invoice already recorded as paid (`<invoice id>:monthly`) is left alone: its failure event came late.
 */
async function paymentFailed(DB, inv, at) {
  const link = await linkForInvoice(DB, inv);
  if (!link) return "unknown customer";
  if (typeof inv.id !== "string" || !inv.id) return "ignored: invoice has no id";
  // Stripe doesn't promise order: a failure delivered (or retried) after the invoice.paid for the same invoice must
  // not mark them failed or email them that a payment they've made didn't go through.
  if (await DB.prepare("SELECT 1 AS yes FROM payments WHERE id = ?").bind(`${inv.id}:monthly`).first()) {
    return "card failed earlier, but that invoice is paid now";
  }
  await DB.prepare("UPDATE client_links SET failed_on = ? WHERE client_id = ?").bind(ukDay(inv.created, at), link.client_id).run();

  const client = await DB.prepare(`SELECT c.name, c.place_id, c.monthly_pence, l.email, p.greet_name FROM clients c
      JOIN client_links l ON l.client_id = c.id LEFT JOIN prospects p ON p.place_id = c.place_id WHERE c.id = ?`)
    .bind(link.client_id).first();
  const name = text(client?.name) || text(inv.customer_name) || text(inv.customer_email) || "A client";
  const amountDue = pence(inv.amount_due) || pence(client?.monthly_pence);
  const to = text(client?.email) || text(inv.customer_email);
  const payUrl = text(inv.hosted_invoice_url);
  const head = `Card failed: ${name}${amountDue ? ` (${formatPounds(amountDue)})` : ""}.`;
  const payLink = payUrl ? `Their pay link: ${payUrl}` : "";
  // The title says they were emailed only when an email is really queued (below, a no-mailbox send rewrites it).
  const todoId = await addTodo(DB, {
    kind: "payment", dedupe: `payment:failed:${inv.id}`,
    title: to ? `${head} They've been emailed a link to pay; Stripe will retry.`
      : `${head} We have no email address for them: send them the pay link yourself; Stripe will retry.`,
    detail: to ? payLink : `We have no email address for them, so nobody has emailed them yet.${payUrl ? ` ${payLink}` : ""}`,
    link: "/#/money", place_id: client?.place_id ?? null, client_id: link.client_id,
  });
  if (!todoId) return "card failed again (already emailed)";
  if (!to) return "marked payment failed (no email address)";
  let sent;
  try {
    sent = await sendClientMail(DB, {
      client_id: link.client_id, place_id: client?.place_id ?? null, to, business: name, now: at,
      compose: (signName) => paymentFailedEmail({ business: name, greetName: client?.greet_name, amountDue, payUrl, signName }),
      noMailboxTodo: {
        dedupe: `setup:client-mail:${link.client_id}:payment-failed:${inv.id}`,
        title: "Send {name} this email yourself (no mailbox yet)",
      },
    });
  } catch (err) {
    // The email didn't go: take the todo back, so Stripe's retry of this event (after the 500) files it and emails.
    await DB.prepare("DELETE FROM todos WHERE id = ?").bind(todoId).run();
    throw err;
  }
  if (sent?.queued == null) {
    // No mailbox: nothing went; the email is in Nik's "Send … this email yourself" setup todo.
    await DB.prepare("UPDATE todos SET title = ?, detail = ? WHERE id = ?").bind(
      `${head} No mailbox yet, so nobody has emailed them: send the email in the "Send ${name} this email yourself" todo; Stripe will retry.`,
      payLink, todoId,
    ).run();
    return "marked payment failed (no mailbox: Nik sends the email)";
  }
  return "marked payment failed, client emailed";
}

/** They cancelled: their monthly stops (they keep the website). cancelled_on is set once; Nik switches off the extras. */
async function subscriptionDeleted(DB, sub, at) {
  const id = stripeId(sub.id);
  let link = id ? await DB.prepare("SELECT client_id FROM client_links WHERE stripe_subscription = ?").bind(id).first() : null;
  if (!link) link = await clientForCustomer(DB, stripeId(sub.customer));
  if (!link) return "unknown subscription";
  await DB.prepare("UPDATE clients SET cancelled_on = ? WHERE id = ? AND cancelled_on IS NULL")
    .bind(ukDay(sub.ended_at || sub.canceled_at, at), link.client_id).run();
  const client = await DB.prepare("SELECT name, place_id FROM clients WHERE id = ?").bind(link.client_id).first();
  const name = text(client?.name) || "A client";
  await addTodo(DB, {
    kind: "payment", dedupe: `payment:stopped:${link.client_id}`,
    title: `${name} stopped the monthly plan: switch off the extras (their site stays up)`,
    link: "/#/money", place_id: client?.place_id ?? null, client_id: link.client_id,
  });
  return "marked stopped";
}

/**
 * Money given back: one `refund:<charge id>` row per charge, a negative amount under Refunds. amount_refunded is
 * Stripe's running total, so a later (partial) refund of the same charge updates the amount and they add up. It only
 * ever grows, so the larger total is kept: an older event delivered late can't shrink the refund back.
 */
async function chargeRefunded(DB, charge, eventCreated, at) {
  const id = stripeId(charge.id);
  if (!id) return "ignored: charge has no id";
  const refunded = pence(charge.amount_refunded);
  if (!refunded) return "nothing refunded";
  const customer = stripeId(charge.customer);
  const link = await clientForCustomer(DB, customer);
  const client = link ? await DB.prepare("SELECT name FROM clients WHERE id = ?").bind(link.client_id).first() : null;
  const name = text(client?.name) || text(charge.billing_details?.name) || text(charge.billing_details?.email) || "Stripe refund";
  await DB.prepare(`INSERT INTO payments (id, stripe_customer, name, category, amount_pence, fee_pence, paid_on, created_at)
                    VALUES (?, ?, ?, 'Refunds', ?, 0, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET amount_pence = MIN(payments.amount_pence, excluded.amount_pence)`)
    .bind(`refund:${id}`, customer, name, -refunded, ukDay(eventCreated, at), iso(at)).run();
  return `recorded a ${formatPounds(refunded)} refund to ${name}`;
}

/** They opened Stripe's payment page and left: a hot todo to call them, unless they're already a client. */
async function checkoutExpired(DB, session) {
  const place_id = text(session.metadata?.place_id) || text(session.client_reference_id);
  if (!place_id) return "ignored: not an Aetos order";
  const lead = await DB.prepare("SELECT name FROM leads WHERE place_id = ?").bind(place_id).first();
  if (!lead) return "ignored: unknown lead";
  const client = await DB.prepare("SELECT 1 AS yes FROM clients WHERE place_id = ? AND cancelled_on IS NULL LIMIT 1").bind(place_id).first();
  if (client) return "already a client";
  const id = await addTodo(DB, {
    kind: "hot", dedupe: `checkout:${place_id}`,
    title: `Call ${text(lead.name) || "them"}: they opened the payment page but didn't pay`,
    link: `/#/lead/${place_id}`, place_id,
  });
  return id ? "call todo added" : "call todo already there";
}

async function checkoutCompleted(DB, session, at) {
  const res = await fulfilCheckout(DB, session, { now: at });
  if (res.status !== "ok") return `ignored: ${res.reason}`;
  return res.created ? `client added: ${res.client_id}` : "already recorded";
}

/** What one Stripe event does; returns what was done, in plain English (stored in stripe_events.result). */
export async function handleEvent(DB, env, event, { now: at = new Date(), fetchImpl = fetch } = {}) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case "checkout.session.completed": return checkoutCompleted(DB, obj, at);
    case "invoice.paid": return invoicePaid(DB, env, obj, { now: at, fetchImpl });
    case "invoice.payment_failed": return paymentFailed(DB, obj, at);
    case "customer.subscription.deleted": return subscriptionDeleted(DB, obj, at);
    case "charge.refunded": return chargeRefunded(DB, obj, event.created, at);
    case "checkout.session.expired": return checkoutExpired(DB, obj);
    default: return "ignored";
  }
}

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,250}$/;
// Anything shaped like a Stripe key or webhook secret, so an error that quotes one never reaches a log or Stripe.
const SECRET_RE = /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*]+|\bwhsec_[A-Za-z0-9*]+/g;

/**
 * POST /api/stripe/webhook. The signature is checked first (the endpoint is public: junk is a 400 and changes
 * nothing, not even the health light). An event id already in stripe_events is a repeat: 200 {duplicate: true}
 * and nothing else happens. Otherwise the event is handled, stored and the `stripe` heartbeat set; a handler error
 * is a 500 (Stripe retries later), stores nothing and turns the heartbeat red with what went wrong.
 * → {status: 200 | 400 | 500, json}
 */
export async function handleWebhook(DB, env, { body, signature, now: at = new Date(), fetchImpl = fetch } = {}) {
  const nowDate = toDate(at);
  const raw = typeof body === "string" ? body : "";
  const secret = await webhookSecret(DB);
  if (!secret || !(await verifySignature(raw, signature, secret, Math.floor(nowDate.getTime() / 1000)))) {
    return { status: 400, json: { error: "Bad signature" } };
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    event = null;
  }
  if (!event || typeof event !== "object" || !EVENT_ID_RE.test(String(event.id ?? "")) || typeof event.type !== "string") {
    return { status: 400, json: { error: "That isn't a Stripe event" } };
  }
  if (await DB.prepare("SELECT 1 AS yes FROM stripe_events WHERE id = ?").bind(event.id).first()) {
    return { status: 200, json: { received: true, duplicate: true } };
  }
  const type = event.type.slice(0, 100);
  try {
    const result = String(await handleEvent(DB, env, event, { now: nowDate, fetchImpl })).slice(0, 500);
    await DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, result, at) VALUES (?, ?, ?, ?)")
      .bind(event.id, type, result, iso(nowDate)).run();
    await beat(DB, "stripe", true, type, nowDate);
    return { status: 200, json: { received: true, result } };
  } catch (err) {
    const message = String(err?.message || err || "unknown error").replace(SECRET_RE, "[hidden]").slice(0, 400);
    try {
      await beat(DB, "stripe", false, `Stripe message ${type} failed: ${message}`, nowDate);
    } catch { /* the database itself is down; Stripe's retry is what matters */ }
    return { status: 500, json: { error: `Couldn't process ${type}: ${message}` } };
  }
}
