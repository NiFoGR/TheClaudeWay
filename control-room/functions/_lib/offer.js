// The offer (pure): every price, the weekend deal and the guarantee wording. The only place a price is written down;
// everything else imports it from here (a test fails if any other file in functions/ hard-codes one). All amounts in
// pence.
//
// Owned by stage 0. Later stages only add exports (each tested in its own new test file); none re-creates this module.
import { addUkDays, isWeekendUK, ukDate, ukToUtc } from "./ukTime.js";

const freeze = (o) => Object.freeze(o);

const FULL = freeze({ key: "full", label: "Full Package", build: 195000, monthly: 24900, freeDays: 60 });

// Saturday and Sunday, UK time. The struck-through price is the real weekday price (£1,950), never £2,000: striking
// through a price we never charge would be a false price comparison. "Around £2,000" is only ever spoken.
const WEEKEND = freeze({
  key: "weekend", label: "Weekend deal", build: 175000, wasBuild: FULL.build, monthly: FULL.monthly, freeDays: 90,
});

const WEBSITE = freeze({ key: "website", label: "Website Only", build: 175000, monthly: 0, freeDays: 0 });

export const PACKAGES = freeze({ full: FULL, weekend: WEEKEND, website: WEBSITE });

export const MONTHLY_PENCE = PACKAGES.full.monthly;

export const GUARANTEE = freeze({
  headline: "Top 3 in Google search results in 90 days. GUARANTEED.",
  section: "The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days.",
});

export const BUILD_GUARANTEE = "Website live in 7 days, GUARANTEED.";

export const WEEKEND_BANNER = "Weekend price — ends Sunday midnight";

export const NO_CONTRACT = "No contract. No cancellation fees. If we're not making you money, we don't want your money.";

const GRACE_MS = 30 * 60000;

/** What's on offer at `date`: the weekend deal on Saturday and Sunday (UK time), the Full Package otherwise. */
export function offerFor(date) {
  const weekend = isWeekendUK(date);
  return {
    weekend,
    full: weekend ? PACKAGES.weekend : PACKAGES.full,
    website: PACKAGES.website,
    banner: weekend ? WEEKEND_BANNER : null,
  };
}

/** The package a checkout is charged at: "full" on the weekend is the weekend deal; "website" never changes. */
export function termsFor(pkg, weekend) {
  if (pkg === "website") return PACKAGES.website;
  if (pkg === "full") return weekend ? PACKAGES.weekend : PACKAGES.full;
  throw new Error(`Unknown package ${JSON.stringify(String(pkg).slice(0, 40))}: it must be "full" or "website".`);
}

/**
 * Whether a checkout started at `now` gets the weekend price: on the weekend (UK time), or up to 30 minutes after
 * Sunday midnight UK when the page it came from was rendered on the weekend (`seenWeekend`). Always a boolean.
 */
export function checkoutWeekend(now, seenWeekend) {
  return isWeekendUK(now) || (Boolean(seenWeekend) && isWeekendUK(new Date(now.getTime() - GRACE_MS)));
}

/** Pence as pounds: "£1,950" for whole pounds, "£249.50" otherwise, "-£249" when negative. */
export function formatPounds(pence) {
  if (typeof pence !== "number" || !Number.isFinite(pence) || Math.abs(pence) > Number.MAX_SAFE_INTEGER) {
    const shown = typeof pence === "string" ? JSON.stringify(pence.slice(0, 40)) : String(pence);
    throw new Error(`formatPounds needs an amount in pence (a number), got ${shown}`);
  }
  const whole = Math.round(Math.abs(pence));
  const pounds = String(Math.floor(whole / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const pennies = whole % 100;
  const sign = pence < 0 && whole > 0 ? "-" : "";
  return `${sign}£${pounds}${pennies ? `.${String(pennies).padStart(2, "0")}` : ""}`;
}

const FACT_TERMS = freeze([
  "No contract and no cancellation fees.",
  "If we're not making you money, we don't want your money.",
  "If you stop paying, you keep the website; the monthly work stops.",
  "Your card is taken at checkout and charged automatically when the free days end.",
]);

const pounds = (pence) => pence / 100;

/**
 * The offer at `at` in whole pounds, for Claude's replies (stage 7): built from `offerFor(at)` and `PACKAGES`, so no
 * price is written twice. `weekend_ends_at` is Monday 00:00 UK as "YYYY-MM-DDTHH:MM:SSZ" (null on a weekday). The
 * review and chat-assistant lines are in `included` only when the caller switches them on (settings
 * `offer:review_booster_live` / `offer:chatbot_live`).
 */
export function offerFacts(at, { chatbot = false, reviews = false } = {}) {
  const now = offerFor(at);
  let weekendEndsAt = null;
  if (now.weekend) {
    const today = ukDate(at);
    const sunday = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;
    weekendEndsAt = ukToUtc(addUkDays(today, sunday ? 1 : 2), "00:00").toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const full = {
    build: pounds(now.full.build),
    anchor: pounds(PACKAGES.weekend.wasBuild),
    monthly: pounds(now.full.monthly),
    free_days: now.full.freeDays,
  };
  const websiteOnly = { build: pounds(PACKAGES.website.build) };
  return {
    weekend: now.weekend,
    weekend_ends_at: weekendEndsAt,
    website_only: websiteOnly,
    full,
    amounts: [...new Set([websiteOnly.build, full.build, full.anchor, full.monthly])],
    guarantees: [GUARANTEE.headline, GUARANTEE.section, BUILD_GUARANTEE],
    terms: [...FACT_TERMS],
    included: [
      "A new website, live within 7 days of you sending us your details.",
      "Monthly work to get you into the top 3 on Google for your main service in your town.",
      ...(reviews ? ["Getting more Google reviews from your customers: your review link, QR card and messages."] : []),
      ...(chatbot ? ["A chat assistant on your website."] : []),
      "A monthly report.",
      "If you haven't got a domain, we buy one in your name and you keep it.",
    ],
  };
}
