// "What to do": the owner's checklist on Home. Daily steps come from the live numbers (so a step is ticked when
// there's nothing to do); one-time setup steps are ticked automatically where the system can tell, or by hand.
// Pure, tested in control-room/tests/today.test.mjs.

const SITREP_URL = "https://github.com/NiFoGR/TheClaudeWay/blob/claude/confident-hawking-vi0lgk/SITREP.md";
const DAY = 86400000;

/**
 * n: { hot, waitingClaude, lastResearchAt, stripeLive, autopilotOn } · manual: { key: true } ticked by hand · now: ms
 * Every "#/…" link must be a route in app.js (an unknown route just reloads Home): outreach steps come back with
 * the outreach page in a later stage.
 */
export function steps(n, manual = {}, now = Date.now()) {
  const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const claudeStale = n.waitingClaude > 0 && (!n.lastResearchAt || now - Date.parse(n.lastResearchAt) > 2 * DAY);
  const daily = [
    { key: "sitrep", title: "Read today's SITREP", why: "What happened overnight and what needs you, in one page (1 minute).",
      href: SITREP_URL, external: true, cta: "Open SITREP", status: "todo" },
    { key: "hot", title: n.hot ? `Optional: call ${plural(n.hot, "hot lead")}` : "Optional: call hot leads",
      why: "People who keep looking at their demo. Each lead has a call script in its details.",
      href: "#/leads", cta: "See leads", status: n.hot ? "optional" : "done", doneText: "Nobody hot right now." },
  ];
  if (claudeStale) {
    daily.splice(1, 0, { key: "claude", title: "Claude hasn't researched leads lately",
      why: `${plural(n.waitingClaude, "lead")} waiting. Check the Routine "Aetos lead research (daily)" still exists at claude.ai/code/routines; if not, tell Claude to recreate it.`,
      href: "https://claude.ai/code/routines", external: true, cta: "Check", status: "warn" });
  }
  const setup = [
    { key: "routine", title: "Claude researching leads daily",
      how: "Runs by itself every afternoon (Routine \"Aetos lead research (daily)\" at claude.ai/code/routines). If this stays unticked, tell Claude: it recreates it.",
      done: !!n.lastResearchAt && now - Date.parse(n.lastResearchAt) < 2 * DAY, auto: true },
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
