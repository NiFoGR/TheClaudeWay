// The offer (pure): every price, the weekend deal and the guarantee wording. The only place a price is written down;
// everything else imports it from here (a test fails if any other file in functions/ hard-codes one). All amounts in
// pence.
//
// Owned by stage 0. Later stages only add exports (each tested in its own new test file); none re-creates this module.
import { isWeekendUK } from "./ukTime.js";

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
