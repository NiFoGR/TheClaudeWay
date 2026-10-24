// "What to do": the owner's checklist on Home. Daily steps come from the live numbers (so a step is ticked when
// there's nothing to do); one-time setup steps are ticked automatically where the system can tell, or by hand.
// Pure, tested in control-room/tests/today.test.mjs.
import { researchLight } from "./research.js";

const SITREP_URL = "https://github.com/NiFoGR/TheClaudeWay/blob/claude/confident-hawking-vi0lgk/SITREP.md";

/**
 * n: { hot, waitingClaude, lastResearchAt, oldestQueuedAt, stripeLive, autopilotOn } · manual: { key: true } ticked by
 * hand · now: ms. waitingClaude, lastResearchAt and oldestQueuedAt are researchFacts' queued, lastPostAt and
 * oldestQueuedAt (research-db.js).
 * Every "#/…" link must be a route in app.js (an unknown route just reloads Home): outreach steps come back with
 * the outreach page in a later stage.
 */
export function steps(n, manual = {}, now = Date.now()) {
  const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  // One rule with Setup's research light (research.js): leads waiting and no post for 26 h, counted from the later of
  // the last post and the oldest lead waiting, so a Routine that had nothing to do for days isn't called stopped the
  // moment a search queues leads.
  const claudeStale = researchLight({ queued: n.waitingClaude, lastPostAt: n.lastResearchAt, oldestQueuedAt: n.oldestQueuedAt }, now)
    .level === "red";
  const daily = [
    { key: "sitrep", title: "Read today's SITREP", why: "What happened overnight and what needs you, in one page (1 minute).",
      href: SITREP_URL, external: true, cta: "Open SITREP", status: "todo" },
    { key: "hot", title: n.hot ? `Optional: call ${plural(n.hot, "hot lead")}` : "Optional: call hot leads",
      why: "People who keep looking at their demo. Each lead has a call script in its details.",
      href: "#/leads", cta: "See leads", status: n.hot ? "optional" : "done", doneText: "Nobody hot right now." },
  ];
  if (claudeStale) {
    daily.splice(1, 0, { key: "claude", title: "Claude hasn't researched leads lately",
      why: `${plural(n.waitingClaude, "lead")} waiting. Open claude.ai/code/routines, check "aetos-research" is on and its last run finished, then press Run now. If it's gone, make it again from routines/README.md and paste its URL and token on Setup → Claude.`,
      href: "https://claude.ai/code/routines", external: true, cta: "Check", status: "warn" });
  }
  const setup = [
    { key: "routine", title: "Claude researching leads daily",
      how: "Routine \"aetos-research\" at claude.ai/code/routines: runs every morning at 06:47 and after each search. Set it up once from routines/README.md, then paste its URL and token on Setup → Claude. Ticks itself once Claude has posted research.",
      // An empty queue is normal (the daily search stops at 30 good leads waiting), so it stays ticked once Claude has
      // posted, and unticks only while the stalled step above is showing.
      done: !!n.lastResearchAt && !claudeStale, auto: true },
    { key: "autopilot", title: "Automatic search on", how: "Lead Scraper page → Automatic search → Edit.", done: !!n.autopilotOn, auto: true, href: "#/scraper" },
    { key: "domain", title: "Move aetoswebsites.com to Cloudflare", how: "Steps in docs/setup-domain-email-stripe.md (Namecheap → Cloudflare nameservers, then control.aetoswebsites.com).",
      done: !!manual.domain },
    { key: "mailboxes", title: "Buy the mailboxes", how: "Namecheap Private Email on aetoswebsites.com, then add it on Setup → Mailboxes. Cold emails start 14 days after the date you bought it, to warm it up.",
      done: !!manual.mailboxes },
    { key: "stripe", title: "Stripe: test payment, then live key", how: "Setup page → Stripe card.", done: !!n.stripeLive, auto: true, href: "#/setup" },
    { key: "funnel", title: "Decide the last funnel questions", how: "docs/funnel.md: preview length, call-back link, chasing unpaid order pages, founding-client deal.",
      done: !!manual.funnel },
  ];
  return { daily, setup, setupLeft: setup.filter((s) => !s.done).length };
}
