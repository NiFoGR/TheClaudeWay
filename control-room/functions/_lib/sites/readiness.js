// When Setup → "Client sites" may switch the two offers on (stage 10, docs/rebuild/09-build.md sections 11, 12 and
// 16 item 11). offer:chatbot_live needs the last chat Test (setting chat:last_test) to have passed within 7 days and
// a test site with live_at set; offer:review_booster_live needs a live test site whose review card renders (a
// Google review link, so the card has its QR code). Either can be switched off at any time; this only gates "on".
// Tested in control-room/tests/sites-setup.test.mjs.
//
// D1: one batch of 2 reads.
import { parseJson } from "../util.js";
import { renderReviewCard } from "./card.js";

const WEEK_MS = 7 * 86_400_000;

export const READINESS_REASONS = Object.freeze({
  noTest: "Press Test on the chatbot connection first.",
  failedTest: "The last chatbot test didn't pass: fix what it says and press Test again.",
  oldTest: "The last chatbot test is over a week old: press Test again.",
  noTestSite: "Put the test site live first (Create test client).",
  reviewOff: "The review booster is switched off for the test site: switch it back on on its Site page.",
  noCard: "The test site's review card has no QR code yet: add a Google review link on its Site page.",
});

const LAST_TEST_SQL = "SELECT value FROM settings WHERE key = 'chat:last_test'";
// The newest live test site (is_test = 1 with live_at set), with what its review card shows.
const TEST_SITE_SQL = `SELECT cs.client_id, cs.review_url, cs.features, cs.content, cs.live_at, c.name, c.package
  FROM client_sites cs JOIN clients c ON c.id = cs.client_id
  WHERE cs.is_test = 1 AND cs.live_at IS NOT NULL ORDER BY cs.live_at DESC LIMIT 1`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** chat:last_test's text → {at, ok} or null when it's missing or unreadable. */
function lastTestOf(value) {
  const t = parseJson(value, null);
  if (!isObj(t) || typeof t.at !== "string" || !Number.isFinite(Date.parse(t.at))) return null;
  return { at: t.at, ok: t.ok === true };
}

function chatbotReadiness(last, site, now) {
  if (!last) return { ready: false, reason: READINESS_REASONS.noTest };
  if (!last.ok) return { ready: false, reason: READINESS_REASONS.failedTest };
  if (now.getTime() - Date.parse(last.at) > WEEK_MS) return { ready: false, reason: READINESS_REASONS.oldTest };
  if (!site) return { ready: false, reason: READINESS_REASONS.noTestSite };
  return { ready: true };
}

// The same card /s/review-card serves (serve.js): it "renders" when it carries the QR code.
function reviewReadiness(site) {
  if (!site) return { ready: false, reason: READINESS_REASONS.noTestSite };
  const features = parseJson(site.features, {});
  if (isObj(features) && features.review_booster === false) return { ready: false, reason: READINESS_REASONS.reviewOff };
  const content = parseJson(site.content, null);
  const b = isObj(content?.business) ? content.business : {};
  const reviewUrl = typeof site.review_url === "string" ? site.review_url.trim() : "";
  if (site.package === "website" || !reviewUrl) return { ready: false, reason: READINESS_REASONS.noCard };
  const html = renderReviewCard({ business: b.name || site.name, phone: b.phone || "", owner: "", reviewUrl });
  return html.includes("<svg") ? { ready: true } : { ready: false, reason: READINESS_REASONS.noCard };
}

/** {chatbot: {ready, reason?}, review_booster: {ready, reason?}}: whether each offer switch may be turned on now. */
export async function sitesReadiness(DB, now = new Date()) {
  const [lastRes, siteRes] = await DB.batch([DB.prepare(LAST_TEST_SQL), DB.prepare(TEST_SITE_SQL)]);
  const last = lastTestOf(lastRes.results?.[0]?.value ?? null);
  const site = siteRes.results?.[0] ?? null;
  return { chatbot: chatbotReadiness(last, site, new Date(now)), review_booster: reviewReadiness(site) };
}
