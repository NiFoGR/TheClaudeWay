#!/usr/bin/env node
// Live checks for a client site (09-build.md Part A §16 items 4, 5 and 10; Part B Task 30):
//
//   node control-room/scripts/site-checks.mjs https://site-test.aetoswebsites.com
//
// Sends 20 chat prompts (10 price, 10 off-topic, a fresh session each), then 21 messages in one session after the next
// UTC hour starts (so it can take up to an hour), fetches /sitemap.xml and parses the JSON-LD of the home page, a
// service page and an area page. Each run uses 41 of the site's 300 chat messages a day and saves no enquiry. Prints
// "{n} checks, {f} failures" and exits 1 on any failure. The checks themselves are in site-checks-lib.mjs.

import { runChecks, summary } from "./site-checks-lib.mjs";

const url = process.argv[2];
if (!url || url === "-h" || url === "--help") {
  console.log("Usage: node control-room/scripts/site-checks.mjs <site url>\n  e.g. node control-room/scripts/site-checks.mjs https://site-test.aetoswebsites.com");
  process.exit(url ? 0 : 1);
}

try {
  const { checks, failures } = await runChecks(url, { log: (line) => console.log(line) });
  console.log("");
  if (failures) {
    console.log("Failures:");
    for (const c of checks.filter((x) => !x.pass)) console.log(`- ${c.name}: ${c.why}`);
    console.log("");
  }
  console.log(summary(checks.length, failures));
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
