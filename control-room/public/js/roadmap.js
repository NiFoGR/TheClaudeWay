// Roadmap: everything the Control Room will do (from the System Plan and Launch Action Plan), and where each part is.
// Update this list whenever something ships or a decision changes, so nothing gets forgotten.
import { esc, pageHead, view } from "./lib.js";

const STATUS = {
  built: ["good", "Built"],
  next: ["gold", "Next"],
  later: ["", "Later"],
  you: ["warn", "Needs you"],
};

const ROADMAP = [
  ["Find leads", [
    ["built", "Lead Scraper", "Trade + town → every business on Google Maps, website audit, email, owner, quality score; chains and front-desk businesses filtered out."],
    ["built", "Map Rank heatmaps", "Where each business shows on Google Maps across town; feeds the score and the emails."],
    ["built", "Claude research after each search", "Claude checks only what the scraper couldn't: real emails, the owner's name, unlinked websites, a proper website review, big firms excluded."],
    ["next", "Call list with a call script per lead", "Leads with no email: an auto-filled script (opener, questions, the demo walkthrough, close) and answers to common objections."],
  ]],
  ["Demo sites (the email's whole point)", [
    ["next", "Demo template for the first trade", "Modelled on the UK's top-ranking sites in that trade, filled in from each lead's data, one link per lead."],
    ["next", "View tracking and expiry", "Who opened their demo, how often, which day; the preview comes down on a stated date."],
    ["next", "Order page", "Full Package vs Website Only side by side, weekend deal on Sat–Sun, guarantees, no contract, Order → steps → Stripe payment."],
    ["next", "Request-a-call form", "On the demo, for people who want to talk first: pre-filled, plus 5 quick questions."],
    ["later", "Recent builds / testimonials section", "Concept sites until real clients exist, then real testimonials per trade."],
  ]],
  ["Outreach", [
    ["built", "Start outreach button", "Nothing is emailed until you press Start outreach on a lead (or several ticked at once)."],
    ["built", "Self-improving first email", "Versions compete (Thompson sampling); a win is a demo view, an interested reply or an order. Claude proposes challengers; you approve every one."],
    ["built", "Write it your way", "Your own wording for any email; Claude turns it into a proper version."],
    ["built", "Claude's questions for you", "Claude asks how you'd handle things; your answers become rules for every email and reply."],
    ["you", "Mailboxes", "Buy the 3 mailboxes on aetoswebsites.com, then they warm up for about 2 weeks."],
    ["later", "Sending", "Gmail API + a scheduled worker, spread across the 3 mailboxes, daily limits, follow-ups on day 3, 7 and 14."],
    ["later", "Replies answered by Claude", "Each inbox triggers Claude when a reply lands (same trick as Find leads), so answers go out fast. Haggling, anger, legal or unsure: drafted, not sent, your phone pinged. Unsure → Claude offers a call."],
    ["later", "Warmth score and phone pings", "Demo views, replies and orders rank who to chase; 3+ demo views pings your phone."],
    ["later", "Weekly outreach review Routine", "Claude's weekly look at the test, on your subscription; switched on once emails are going out."],
  ]],
  ["Closing and paperwork", [
    ["built", "Stripe payment links", "One-press setup; payments show on the Money page by themselves."],
    ["next", "Letter of agreement", "One page: what they get, price, 60 days free, no contract, guarantees, who owns what."],
    ["next", "Welcome email after payment", "Sent the minute they pay, with the onboarding form link."],
    ["later", "Founding-client deal", "What the first 3–5 clients get for a testimonial and case study."],
  ]],
  ["Delivery", [
    ["later", "Onboarding form + reminders", "Logo, photos, services, areas, style, Google profile access, web address; 24h/48h reminders. The 7-day clock starts when it's complete."],
    ["later", "Demo → final site", "Claude applies their content and changes; you review; one change round; live by day 7."],
    ["later", "Domain, hosting, chatbot", "Their .co.uk in their name, security certificate, AI receptionist switched on."],
    ["later", "Review poster + 6-month Google post calendar", "QR poster PDF with their logo; a year's posting plan they never think about."],
  ]],
  ["Every month", [
    ["built", "Money page", "Clients, build fees, retainers after the free days, costs, Google API spend."],
    ["later", "Rank and competitor check", "Their Google position on signing day vs today, and what the top firms changed."],
    ["later", "Site updates and client second brain", "Claude proposes improvements and answers change requests (\"yes, and…\"); a profile and timeline per client; you approve."],
    ["later", "Monthly email to each client", "Plain English: what we changed and how it brings them more money."],
    ["later", "Day-61 payment reminder and switch-off", "Stripe reminds them; after 7 days unpaid, everything but the site switches off."],
  ]],
  ["Your business", [
    ["next", "aetoswebsites.com", "The main site (needed for Stripe live approval), privacy page, nearest-town greeting."],
    ["you", "Namecheap → Cloudflare, control.aetoswebsites.com, email routing", "Steps in docs/setup-domain-email-stripe.md."],
    ["you", "Stripe live key", "After a successful test payment."],
  ]],
];

export function roadmapPage() {
  const count = (st) => ROADMAP.flatMap(([, items]) => items).filter(([s]) => s === st).length;
  view.innerHTML = `
    ${pageHead("Roadmap", `Everything the Control Room will do, and where each part is. ${count("built")} built, ${count("next")} next, ${count("later")} later, ${count("you")} waiting on you.`)}
    ${ROADMAP.map(([group, items]) => `
      <div class="section-title"><h2>${esc(group)}</h2></div>
      <div class="card"><div class="cost-rows">${items.map(([st, name, what]) => {
        const [cls, label] = STATUS[st];
        return `<div class="road-row"><span class="badge ${cls}">${label}</span><div><b>${esc(name)}</b><div class="muted small">${esc(what)}</div></div></div>`;
      }).join("")}</div></div>`).join("")}`;
}
