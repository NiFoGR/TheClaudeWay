// User-agents whose demo visits are never counted (05-demo.md Part A §8, Task 11): search and social crawlers, link
// previews, email security scanners (Safe Links, Proofpoint, Mimecast…), headless browsers, speed testers and
// scripts. Pure. Used by the beacon, POST /d/:slug/e. Tested in control-room/tests/demo-routes.test.mjs.

/** The bot and link-scanner list, exactly as the spec gives it (no g flag, so test() keeps no state). */
export const BOT_UA = /bot|crawl|spider|slurp|preview|scan|monitor|fetch|headless|lighthouse|pagespeed|python|curl|wget|go-http|java\/|okhttp|axios|node|facebookexternalhit|whatsapp|telegram|skype|slack|discord|outlook|microsoft office|safelinks|proofpoint|mimecast|barracuda|bitdefender/i;

/** Whether a user-agent looks like a bot or link scanner; an empty, blank or missing one counts as a bot too. */
export function isBotUA(ua) {
  const text = typeof ua === "string" ? ua.trim() : "";
  return !text || BOT_UA.test(text);
}
