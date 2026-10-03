// What each Stripe webhook event does to the database. Pure-ish: takes D1 + the event, so it's testable.
import { PACKAGES } from "./money.js";
import { stripe } from "./stripe.js";
import { now } from "./util.js";

const day = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

async function clientForCustomer(DB, customer) {
  return customer ? DB.prepare("SELECT client_id FROM client_links WHERE stripe_customer = ?").bind(customer).first() : null;
}

/** A new client paid through a payment link: add them as a client (and mark the matching lead won). */
async function checkoutCompleted(DB, s) {
  const pkgKey = s.metadata?.goldbar_package;
  const pkg = PACKAGES[pkgKey];
  if (!pkg || !s.customer) return "ignored: not a GoldBar payment link";
  if (await clientForCustomer(DB, s.customer)) return "already recorded";
  const business = (s.custom_fields || []).find((f) => f.key === "business")?.text?.value;
  const name = String(business || s.customer_details?.name || s.customer_details?.email || "New client").trim().slice(0, 120);
  const id = crypto.randomUUID();
  const paidOn = day(s.created);
  const lead = await DB.prepare("SELECT place_id FROM leads WHERE lower(name) = lower(?) AND excluded = 0 LIMIT 1").bind(name).first();
  const stmts = [
    DB.prepare(`INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, name, lead?.place_id || null, pkgKey, pkg.build, pkg.monthly, pkg.freeDays, paidOn,
        [s.customer_details?.email, s.customer_details?.phone].filter(Boolean).join(" · "), now()),
    DB.prepare("INSERT OR REPLACE INTO client_links (client_id, stripe_customer, stripe_subscription, email) VALUES (?, ?, ?, ?)")
      .bind(id, s.customer, s.subscription || null, s.customer_details?.email || null),
  ];
  if (lead) stmts.push(DB.prepare("UPDATE leads SET status = 'won', updated_at = ? WHERE place_id = ?").bind(now(), lead.place_id));
  // one-off (Website Only) payments have no invoice: record the money here
  if (s.mode === "payment" && s.amount_total > 0) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO payments (id, stripe_customer, name, category, amount_pence, paid_on, created_at)
                           VALUES (?, ?, ?, 'Website builds', ?, ?, ?)`).bind(s.id, s.customer, name, s.amount_total, paidOn, now()));
  }
  await DB.batch(stmts);
  return `client added: ${name}`;
}

/** Money actually received on an invoice: the build fee (first invoice) and/or a monthly payment. */
async function invoicePaid(DB, env, inv) {
  if (!inv.amount_paid) return "nothing paid (free trial invoice)";
  const parts = { "Website builds": 0, "Monthly retainers": 0 };
  for (const line of inv.lines?.data || []) parts[line.type === "subscription" ? "Monthly retainers" : "Website builds"] += line.amount;
  const total = parts["Website builds"] + parts["Monthly retainers"] || 1;
  let fee = 0;
  if (inv.charge) {
    try {
      const charge = await stripe(env, "GET", `charges/${inv.charge}?expand[]=balance_transaction`);
      fee = charge.balance_transaction?.fee || 0;
    } catch { /* the payment still counts; only the fee is missing */ }
  }
  const link = await clientForCustomer(DB, inv.customer);
  const client = link ? await DB.prepare("SELECT name FROM clients WHERE id = ?").bind(link.client_id).first() : null;
  const name = client?.name || inv.customer_name || inv.customer_email || "Stripe payment";
  const paidOn = day(inv.status_transitions?.paid_at || inv.created);
  const stmts = Object.entries(parts).filter(([, amount]) => amount > 0).map(([category, amount]) =>
    DB.prepare(`INSERT OR IGNORE INTO payments (id, stripe_customer, name, category, amount_pence, fee_pence, paid_on, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`${inv.id}:${category === "Website builds" ? "build" : "monthly"}`, inv.customer, name, category,
        Math.round((amount / total) * inv.amount_paid), Math.round((amount / total) * fee), paidOn, now()));
  if (link) stmts.push(DB.prepare("UPDATE client_links SET failed_on = NULL WHERE client_id = ?").bind(link.client_id));
  if (stmts.length) await DB.batch(stmts);
  return `recorded ${inv.amount_paid}p from ${name}`;
}

async function paymentFailed(DB, inv) {
  const link = await clientForCustomer(DB, inv.customer);
  if (!link) return "unknown customer";
  await DB.prepare("UPDATE client_links SET failed_on = ? WHERE client_id = ?").bind(day(inv.created), link.client_id).run();
  return "marked payment failed";
}

/** They cancelled: their monthly stops (they keep the website). */
async function subscriptionDeleted(DB, sub) {
  const link = await DB.prepare("SELECT client_id FROM client_links WHERE stripe_subscription = ?").bind(sub.id).first();
  if (!link) return "unknown subscription";
  await DB.prepare("UPDATE clients SET cancelled_on = ? WHERE id = ? AND cancelled_on IS NULL")
    .bind(day(sub.ended_at || sub.canceled_at || Math.floor(Date.now() / 1000)), link.client_id).run();
  return "marked stopped";
}

export async function handleEvent(DB, env, event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": return checkoutCompleted(DB, obj);
    case "invoice.paid": return invoicePaid(DB, env, obj);
    case "invoice.payment_failed": return paymentFailed(DB, obj);
    case "customer.subscription.deleted": return subscriptionDeleted(DB, obj);
    default: return "ignored";
  }
}
