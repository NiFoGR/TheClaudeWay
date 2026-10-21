// "What to do": the owner's checklist on Home. Daily steps come from the live numbers (so a step is ticked when
// there's nothing to do); one-time setup steps are ticked automatically where the system can tell, or by hand.
// Pure, tested in control-room/tests/today.test.mjs.

const SITREP_URL = "https://github.com/NiFoGR/TheClaudeWay/blob/claude/confident-hawking-vi0lgk/SITREP.md";
const DAY = 86400000;

/**
 * n: { picks, proposals, questions, flaggedReplies, hot, waitingClaude, lastResearchAt, liveFirstEmails,
 *      stripeLive, autopilotOn } · manual: { key: true } ticked by hand · now: ms
 */
export function steps(n, manual = {}, now = Date.now()) {
  const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const claudeStale = n.waitingClaude > 0 && (!n.lastResearchAt || now - Date.parse(n.lastResearchAt) > 2 * DAY);
  const daily = [
    { key: "sitrep", title: "Read today's SITREP", why: "What happened overnight and what needs you, in one page (1 minute).",
      href: SITREP_URL, external: true, cta: "Open SITREP", status: "todo" },
    { key: "picks", title: n.picks ? `Approve today's picks (${n.picks} ready)` : "Approve today's picks",
      why: "Untick anyone you don't want, approve the rest: their demo is built and they join the emails.",
      href: "#/outreach", cta: "Go to picks", status: n.picks ? "todo" : "done", doneText: "No new leads waiting." },
    { key: "versions", title: n.proposals ? `Approve or reject ${plural(n.proposals, "email version")}` : "Check new email versions",
      why: "Nothing is sent in your name until you approve it.",
      href: "#/outreach", cta: "Review", status: n.proposals ? "todo" : "done", doneText: "Nothing waiting." },
    { key: "questions", title: n.questions ? `Answer ${plural(n.questions, "question")} from Claude` : "Answer Claude's questions",
      why: "Your answers become rules for every email and reply.",
      href: "#/outreach", cta: "Answer", status: n.questions ? "todo" : "done", doneText: "No questions." },
    { key: "replies", title: n.flaggedReplies ? `Handle ${plural(n.flaggedReplies, "reply", "replies")} Claude left for you` : "Handle flagged replies",
      why: "Haggling, complaints or anything Claude wasn't sure about. Everything else it answers itself.",
      href: "#/outreach", cta: "Open", status: n.flaggedReplies ? "todo" : "done", doneText: "None flagged." },
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
    { key: "autopilot", title: "Autopilot on", how: "Lead Scraper page → Autopilot → Edit.", done: !!n.autopilotOn, auto: true, href: "#/scraper" },
    { key: "emails", title: "Approve the starting emails", how: "Outreach page: approve two first-email versions and the follow-ups.",
      done: n.liveFirstEmails >= 2, auto: true, href: "#/outreach" },
    { key: "domain", title: "Move aetoswebsites.com to Cloudflare", how: "Steps in docs/setup-domain-email-stripe.md (Namecheap → Cloudflare nameservers, then control.aetoswebsites.com).",
      done: !!manual.domain },
    { key: "mailboxes", title: "Buy the mailboxes", how: "Namecheap Private Email on aetoswebsites.com, then tell Claude: sending gets connected and warm-up starts (about 2 weeks).",
      done: !!manual.mailboxes },
    { key: "stripe", title: "Stripe: test payment, then live key", how: "Setup page → Stripe card.", done: !!n.stripeLive, auto: true, href: "#/setup" },
    { key: "funnel", title: "Decide the last funnel questions", how: "docs/funnel.md: preview length, call-back link, chasing unpaid order pages, founding-client deal.",
      done: !!manual.funnel },
  ];
  return { daily, setup, setupLeft: setup.filter((s) => !s.done).length };
}
