# Cross-file reconciliation (applied to the stage files)

The review that lined the stage files up with each other. Each item says which version won and what changed.


I read all 14 files and checked the current `lead-manager/schema.sql`, which has 29 statements and already has `clients.place_id`, `client_links.failed_on`, `demos.expires_at`, `scans.source` and `suppression.kind`. I made no edits.

**How each resolution was picked.** Usually the earliest stage's version wins and later files are patched. I picked a later shape where it is already shared by several files, or where the earliest version breaks a decision or the truth rule. Each of those cases says so.

---

## BLOCKING (code breaks or tests contradict)

**1. `_lib/offer.js` is defined five different ways.**
- **Where:**
  - 01 Task 6: `PACKAGES{full,weekend,website}`, `offerFor → {weekend, full, website}`, `formatPounds`, `GUARANTEE{headline,section}`, `BUILD_GUARANTEE`.
  - 04 Task 1: flat `*_PENCE` constants, `offerFor → {build_pence, anchor_pence, …}`, `gbp`.
  - 05 Tasks 4 and 10: `offerNow(now)`, plus its own `GUARANTEE{headline, detail}` in `demo/data.js`.
  - 07 Task 2: `offerFacts` in pounds.
  - 08 Task 1: re-creates `PACKAGES` with a different weekend label, top-level `wasBuild: 195000`, `pounds`, `GUARANTEE_HEADLINE`/`GUARANTEE_SECTION`.
  - 10 Tasks 7–8 and 11 Task 10 consume 04's `MONTHLY_PENCE`, `FULL_BUILD_PENCE`, `gbp`.
  - 01, 04 and 08 each **create** `tests/offer.test.mjs`.
- **Conflict:** each later stage re-creates or overwrites the module and its test, with return shapes the other stages can't read.
- **Resolution — 01 owns `offer.js`; later stages only add exports, and only in new test files.**
  - 01 Task 6:
    - Also export `MONTHLY_PENCE = PACKAGES.full.monthly`, `termsFor(pkg, weekend)` and `checkoutWeekend(now, seenWeekend)` (08's code).
    - Make `formatPounds` handle pennies and negatives (08's `pounds` tests).
    - Export `WEEKEND_BANNER` and `NO_CONTRACT`.
    - `offerFor(date)` returns `{weekend, full, website, banner}`.
    - `wasBuild` stays inside `PACKAGES.weekend` (value: see item 21).
  - 04: delete Task 1. Replace `gbp` with `formatPounds` and `o.build_pence` with `o.full.build` (likewise `anchor` → `o.full.wasBuild`, `free_days` → `o.full.freeDays`, `monthly` → `o.full.monthly`). Update the Task 8 interface text and the cross-stage list.
  - 05 Tasks 4 and 10: `offerNow` → `offerFor`. Delete the local `GUARANTEE`; import `GUARANTEE` from `offer.js` and rename `detail` → `section`.
  - 07 Task 2: add only `offerFacts(at, extras)`, built from `PACKAGES`; its test file stays `offer-facts.test.mjs`.
  - 08 Task 1: "Modify `offer.js`" (don't create it). Use `GUARANTEE.headline`/`.section` and `formatPounds`. Move its tests to a new `offer-order.test.mjs`. Drop the `money.js` re-export step (01 already did it).
  - 10 Task 7 and 11 Task 10: replace `gbp`/`*_PENCE` with `formatPounds`/`PACKAGES`/`MONTHLY_PENCE`. 11 Task 10 drops "build `PACKAGES` from constants".

**2. `callScript`'s `offer` input differs between 04 and 07.**
- **Where:** 04 Task 8 (pence shape, throws without `offer`) vs 07 Task 16 (`offerFacts` JSON in pounds; test fixtures `WEEKDAY_OFFER = {full:{build:1950…}}`).
- **Conflict:** 07 rewrites 04's tests with an incompatible shape.
- **Resolution — 04's contract wins (`opts.offer = offerFor(date)` plus `GUARANTEE`).**
  - 07 Task 16 builds `WEEKDAY_OFFER`/`WEEKEND_OFFER` with `offerFor(new Date(...))`, keeps 04's "throws without offer" test, and changes the call page's `lead.director_first_name` to `owner_first`.
  - 07 Task 13: `GET /api/calls/:id` returns `offer: offerFor(slot_at)` (`page.offer.full.build === 195000`).

**3. The health-light object has six shapes, and `healthFromDb` has two signatures.**
- **Shapes in use:**
  - 01: `{name,state,message,fix}`
  - 03 and 11: `{name,level,detail,fix}`
  - 06: `{name,light,detail}`
  - 07: `{key,color,text}`
  - 08: `{name:"Payments (Stripe)",color,text}`
  - 09: `{name,colour,detail}`
  - 10: consumes `{name,ok,level?,detail}` and produces `{name,level,detail}`
- **Signatures:** 01 has `healthFromDb(DB, env, now) → {lights, gaps}`. 07 Task 7's test and 11 Task 3 call `healthFromDb(DB, now)` and expect an array.
- **Resolution — one shape `{name, level: "green"|"amber"|"red"|"grey", detail, fix}` (03/11's, plus grey).**
  - 01 Part A "Health lights" table and Task 17: rename `state` → `level` and `message` → `detail`. Grey means "not in use"; it never adds a todo.
  - 01 adds `registerLight(fn)` to `health.js`. `healthFromDb(DB, env, now)` returns `{lights: computeLights(...) ++ registered, gaps}`.
  - Every later stage registers its light; none edits `computeLights`:
    - 06 Task 15: `{name:"followups",level,detail,fix}`.
    - 07 Tasks 5 and 7: `replyLight → {name:"replies",level,detail,fix}`.
    - 08 Task 2: `stripeLight → {name:"payments",…}`.
    - 09 Task 28: `level` instead of `colour`.
    - 10 Task 14: add `fix`.
  - 07 Task 7 test: `(await healthFromDb(DB, env, now)).lights.find(l => l.name === "replies").level`.
  - 11 Task 3: `(await healthFromDb(DB, env, now)).lights`.

**4. Light names collide or duplicate each other.**
- **Where:** 01 (`research_queue`, `routine:weekly-kpis`, `routine:monthly-care`, test "no light name is a prefix of another"), 02 ("Lead search" from heartbeat `find`, no task builds it), 03 Task 7 (`research`), 10 Task 14 (`routine:monthly-care`), 11 Task 6 (`weekly-kpis`).
- **Conflicts:**
  - `research` is a prefix of `research_queue`. The 01 test fails, and `closeTodos("health:research")` would close `health:research_queue`.
  - 10 and 11 add second lights for routines 01 already watches. Two lights with one dedupe make the todo open and close every tick.
  - A light named `find` would have its `health:find` prefix close 02's `health:find:towns`, `health:find:failed:*` and `health:find:<date>` todos.
- **Resolution:**
  - 01: delete the `research_queue` light; 03's `research` light (with the hit-rate amber) replaces it.
  - 02: Task 12 registers a `lead_search` light (red when the `find` beat has `ok=0` or is more than 26 h old).
  - 10: Task 14 renames its routine light to `care_drafts` (amber when a draft has been pending more than 24 h) and drops the 32-day rule, which 01's cadence of 768 h already covers.
  - 11: Task 6 deletes `kpisLight` and the `weekly-kpis` light (01's `routine:weekly-kpis`, 192 h, covers it).
  - 01's light-count tests (Task 17, "Perfect when" 9) assert `computeLights(...).length === 10` and the stage-0 name list, not "11 lights from `/api/health`".

**5. Schema: hard-coded statement count, and columns added after the tables exist.**
- **Where:** 01 Task 3 (`assert len(stmts) == 52`), 07 Task 1 (`messages.intent`, `calls.note`, plus a manual `ALTER` for Nik), 08 Task 8 (`stripe_events`, +1), 09 Task 1 (+9), 10 Task 1 (+7). Overview §4 lists none of them.
- **Conflicts:**
  - Pytest fails at stages 08, 09 and 10.
  - 07's columns never reach the live D1 (`CREATE TABLE IF NOT EXISTS` doesn't add columns), so Nik would have to run SQL by hand.
- **Resolution:**
  - Overview §4 and 01 Task 3: add `intent TEXT` to `messages` (after `handled_at`) and `note TEXT NOT NULL DEFAULT ''` to `calls` (after `phone`).
  - Add a §4 sub-heading "Tables added by later stages" listing `stripe_events` (08), `client_sites`/`site_leads`/`chat_usage`/`site_files`/`rate_hits` (09) and `care`/`care_tasks`/`care_scans`/`care_reviews` (10).
  - 01 Task 3: change `test_leads.py` to `assert len(stmts) >= 52`. 08 Task 8, 09 Task 1 and 10 Task 1 each add their tables to `test_rebuild_tables_present`.
  - 07 Task 1: keep only the stage events and an existence assertion; delete the `ALTER` instruction.

**6. The stage machine is missing events later stages use.**
- **Where:** overview §5, 01 Task 7 (test asserts `nextStage("lost","paid") === "lost"`), 07 Task 1 (`nik_handled`, `call_cancelled`), 07 Task 8 (`no_show` → "back to replied", with no event named), 07 Q2 (re-open after "not now"), 08 Task 7 ("lost then paid → won").
- **Conflict:** 01's test asserts the opposite of 08's, and 07's outcomes have no event to fire.
- **Resolution — final table in overview §5 and 01 Task 7:**
  - `demo_ready`: null/`ready` → `ready`
  - `first_sent`: `ready` → `emailed`
  - `demo_view`: `emailed` → `viewed`
  - `inbound_human`: `emailed`/`viewed`/`call_booked` → `replied`
  - `reopen`: `lost` → `replied` (fired by 07's `onHumanInbound` only when `lost_reason` is `not_now`, `not_interested`, `sequence_done` or `call`)
  - `escalate`: open stages → `needs_nik`
  - `nik_handled`: `needs_nik` → `replied`
  - `call_confirmed`: open stages except `ready` → `call_booked`
  - `call_cancelled`: `call_booked` → `replied` (also used for `no_show`)
  - `said_no` / `sequence_done`: open stages → `lost`
  - `paid`: any stage → `won`
  - `opt_out` / `bounce`: any stage except `won` → `lost` (see item 30)
  - 01's test changes to `nextStage("lost","paid") === "won"`. 07 Task 1 and 08 Task 7 drop their `stages.js` edits.

**7. `applyStageEvent` is defined twice, and several stages bypass it.**
- **Where:** 01 Task 7 (`prospects.js`, returns `{from,to}|null`); 07 Task 6 (`replies-db.js`, returns a string; also says the inbound step is in `tick.js`, but it is in `_lib/mail/inbound-db.js`). Direct `nextStage` writes: 05 Tasks 8 and 11, 06 Task 7 ("every change goes through `nextStage`"), 08 Task 7.
- **Resolution — 01's wins.**
  - 07 Task 6: delete its `applyStageEvent`, import from `prospects.js`, and change the test to `(await applyStageEvent(...)).to === "lost"`. Call `onHumanInbound` from `processInbound` in `_lib/mail/inbound-db.js`.
  - 05 Task 11 (`countView`), 06 Task 7 (`syncSent`), 06 Task 8 (`closeFinished`) and 08 Task 7 (`fulfilCheckout`): call `applyStageEvent`.
  - 01: add an `{email, greet_name}` option for inserting a new row. 05 Task 8 and 08 Task 7 use it.
  - 06 Global Constraints: replace "through `nextStage`" with "through `applyStageEvent`".

**8. `_lib/followups.js` is created twice, and `followupsDueToday` has two return shapes.**
- **Where:** 04 Task 3 creates it with `followupsDueToday → number`. 06 Task 1 says **Create** the same file; 06 Task 6 returns `{total, byMailbox}`.
- **Conflict:** 04's `followups-due` test and `capacityNow` break.
- **Resolution:**
  - 06 Task 1: "Modify `_lib/followups.js` (keep `followupsDueToday` and its test)".
  - 06 Task 6: rename its function `followupsDueByMailbox(DB, now) → {total, byMailbox}` and update the cross-stage list.

**9. `dispatchDue` is missing options and rules that later stages need.**
- **Where:** 01 Task 13 (`{limit, send}`; paused mailbox holds every kind; orders by `due_at` only). 06 cross-stage (a)–(d): follow-ups before first emails at cap, pass the row's `message_id`/`in_reply_to`/`refs` through; the Task 16 test "fails until stage 0's dispatchDue orders follow-ups first", but no task changes the outbox. 07 Task 10 calls `{limit:1, kinds:["reply"]}`; 07 says replies go from a mailbox paused for cold sending.
- **Resolution — 01 Task 13 defines the final contract:**
  - Options: `dispatchDue(DB, env, now, {limit = 2, send = sendViaSmtp, kinds = null})` returning `{sent, failed, held}`.
  - Order: `CASE kind WHEN 'followup' THEN 0 WHEN 'first' THEN 1 ELSE 2 END, due_at`.
  - Headers: use the row's `message_id`/`in_reply_to`/`refs` when set, and generate a `message_id` only when it is null.
  - Paused mailbox: holds only `first`/`followup`; `reply` and `system` still go. This is 07's rule. Change 01's Part A "Before every send" line and its test "paused mailbox sends nothing" to "holds a `first`, sends a `reply`".
  - Add 01 tests for `kinds` and the ordering. Delete 06's "until stage 0's…" note.

**10. The composer's file name and export differ between 04 and 06.**
- **Where:** 04 Task 9 dynamically imports `./composer.js` `openComposer(detail,{onSent})`. 06 Task 13 builds `public/js/compose.js` `mountEmail(el, placeId)`.
- **Conflict:** the import fails forever, so "Write first email" only toasts "arrives with the next stage".
- **Resolution — 06 wins.**
  - 04 Task 8: `drawerHtml` renders empty mount points `<div id="d-demo"></div><div id="d-email"></div><div id="d-call"></div>`.
  - 04 Task 9: the button does `import("./compose.js").then(m => m.mountEmail(document.getElementById("d-email"), id))` and scrolls to it.
  - Update 04's cross-stage list.
  - 05 Task 14 and 07 Task 16 mount into `#d-demo` and `#d-call`.

**11. The Voice page is built twice.**
- **Where:** 06 Tasks 12 and 14 (`api/voice/index.js`, `api/voice/followups/*`, `api/voice/examples/*`, `public/js/voice.js`, `voice.test.mjs`) vs 07 Task 14 (`api/voice.js`, `api/voice/[id].js`, `public/js/voice.js`, `voice.test.mjs`).
- **Conflict:** `api/voice.js` and `api/voice/index.js` both answer `/api/voice`, and 07 overwrites 06's page and test.
- **Resolution — 06 wins.**
  - 07 Task 14 shrinks to:
    - put `seedVoice` into 06's `GET /api/voice`;
    - widen `has_price_reply` to 07's `/price|how much|cost/i` over `situation`/`body` of `example` rows with source `nik_written` (sent first emails never count);
    - add tests to a new `voice-seed.test.mjs`.
  - Delete 07's Voice copy block in Part A ("What Nik sees") and its nav addition.

**12. `sendNikReply` doesn't exist.**
- **Where:** 11 Task 3 `POST /api/todo/:id/send` needs `sendNikReply(DB,{place_id,body,now})`; 07 Task 11 produces `sendAsNik(DB,{message_id,body,now})`.
- **Resolution — 07's function wins.** 11 Task 3 takes the message id from the todo's dedupe (`escalation:<id>` / `call_time:<id>`, strip any `@…`), calls `sendAsNik`, and updates the cross-stage line.

**13. `stripe()` is removed before care uses it.**
- **Where:** 10 Task 9 and R2 call `stripe(env, method, path, params)`; 08 Task 2 removes `stripe(env…)` in favour of `stripeApi(key, method, path, params, fetchImpl)` + `stripeKey(env, DB)`.
- **Resolution:** 10 Task 9 becomes `pauseFee(DB, env, subId, day90, {fetchImpl})`, which calls `stripeApi((await stripeKey(env, DB))?.key, "POST", "subscriptions/"+id, …)`. The test uses 08's `fakeStripe`. Update the R2 text.

**14. Client-site host routing would 404 the Control Room.**
- **Where:** 09 Tasks 6 and 22: `OUR_HOSTS` lists only aetoswebsites.com, www, localhost and `*.pages.dev`, plus `env.APP_HOST`; any other host with no `client_sites` row gets 404 "This website isn't set up yet." 01 serves the Control Room on "every other host" (its tests use `control.aetoswebsites.com`), and Nik never edits Cloudflare variables.
- **Resolution:** 09 Task 22: if `siteByHost` finds no row, call `next()` into 01's routing instead of returning 404. Drop `APP_HOST`. Delete the "unknown.example → 404" test and add "control.x → login".

**15. `roadmap.js` is edited after 01 deletes it.**
- **Where:** 01 Task 23 deletes `public/js/roadmap.js`; 02 Task 15, 03 Task 9 and 05 Task 14 modify it and `git add` it (pathspec error).
- **Resolution:** remove `roadmap.js` from the file lists and commit commands of 02 Task 15, 03 Task 9 and 05 Task 14.

**16. The `fakeD1` helper lacks a method 11's tests use.**
- **Where:** 11 Task 3 test calls `DB.exec(seedSql)`; 01 Task 2 exposes only `{prepare, batch, raw}`.
- **Resolution:** 01 Task 2 adds `exec(sql)` → `raw.exec(sql)`, plus a test.

**17. Final navigation and routing drop pages built by other stages.**
- **Where:** 11 Task 11 (`NAV` without Replies; `routeFor` sends unknown routes to Todo and lists only demo/lead/kpis…); 07 Task 15 (nav "Replies", `#/replies`, `#/replies/<id>`, `#/call/<id>`); 09 Task 25 and 10 Task 15 register `sites`, `site/<id>`, `client/<id>`, `client/settings` in `app.js`/`PAGES`, which 11 has already replaced.
- **Resolution:**
  - 11 Task 11: `NAV` = Todo, Leads, Scraper, Map Rank, Replies, KPIs, Money, Voice, Setup.
  - `routeFor` knows: `todo`, `leads`, `lead/<id>`, `lead/<id>/thread` (→ replies), `scraper`, `maprank`, `replies`, `replies/<id>`, `call/<id>`, `kpis`, `money`, `voice`, `setup`, `demo`. The nav test covers each.
  - 09 Task 25 and 10 Task 15 add their routes to `nav.js` `routeFor` (and `nav.test.mjs`), not to `PAGES`.
  - Overview: 11 is the routing owner after it ships.

---

## IMPORTANT (behaviour differs)

**18. The capacity banner and the composer disagree about room for first emails.**
- **Where:** 04 (room = cap − sent − due today − queued) vs 06 Task 9 (`no_room` also reserves every future follow-up day). The banner can say "send 3" while Send refuses.
- **Resolution — 06 wins.** 06 Task 6 also modifies 04's `capacityNow`: `room = min(04's formula, (await roomForFirsts(DB, now)).total)`. 04's banner text is unchanged.
- **Also:** 04's `firstQueued` counts `queued` only, because 01's `sentToday` already counts `sending`. Fix 04's assumption line "`sentToday` counts only `status='sent'`".

**19. The research card, "Research again" and the point reasons conflict between 03 and 04.**
- **Where:** 03 Task 8 (`researchcard.js`, "Research is wrong" with a note, no fire, points stored as `points.reasons`) vs 04 Tasks 6 and 8 (own grade card in `leadview.js`, "Research again" button that fires, reads `points.why`). 04's notes prefix `Not a fit (Nik): …` is dropped by 03's `mergeNotes`.
- **Resolution:**
  - 04 Task 8: `drawerHtml` embeds 03's `researchCard(...)` for the grade, angle, opener, owner/emails and site review sections. Delete `POINT_LABELS`/the grade card. Read `points.reasons`.
  - 04 Task 6: delete `research-again`. Its 30-minute guarded fire moves into 03's `POST /api/research/:id/wrong`, with 04's toasts.
  - 04 Not-a-fit: write `[Nik YYYY-MM-DD] Not a fit: {reason}`.

**20. The research queue skips too little and can quote false Maps lines.**
- **Where:** 02 cross-stage (stage 2 must skip suppressed leads and never quote a Maps line when `audit.map_rank.home` is false) vs 03 Task 4 (skips only excluded or missing leads; passes all `findings`/`map_rank`).
- **Resolution:** 03 Task 4:
  - also mark rows `skipped` when 02's suppression check matches;
  - drop `maps_*`/`reviews_behind` findings and set `map_rank: null` when `audit.map_rank.home === false` or `scan_town` isn't the lead's town;
  - add tests for both.

**21. The weekend crossed-out price differs.**
- **Where:** 01 (`wasBuild 200000`, landing `<s>£2,000</s>` and its test), 04 call script ("around £2,000"), 07 (`offerFacts.full.anchor 2000`; the guard allows £2,000) vs 08 (crossed-out £1,950; legal reasoning; Q1).
- **Resolution — 08 wins (truth rule).**
  - 01: `wasBuild 195000`, landing `~~£1,950~~`, test `<s>£1,950</s>`.
  - 07: `anchor 1950`, and the allowed amounts in the reply checks are `[249, 1750, 1950]`.
  - 04's spoken "around £2,000" stays: it is true of £1,950.
  - This is a question for Nik (Q-A below).

**22. The 90-day guarantee clock starts on different days, and two Clients sections show different numbers.**
- **Where:** 10 R1/R2 (day 0 = the day Nik becomes Manager on the Google profile; care scans are 7×7) vs 11 Task 2 (`guaranteeWords` from `live_at`; rank from the 5×5 town scan in `lead_map_rank`). 10 "What Nik sees" wants 11's board to render `GET /api/care/clients` via `renderClientsSection`; 11 already built `clientCards`.
- **Resolution — 10 owns the guarantee and rank figures; 11 owns the card.**
  - 10 Task 15: modify 11's `loadBoard`/`clientCards` so that a client with a `care` row takes `guarantee` from `guaranteeLabel(care)` and `rank` from the latest scored `care_scans` row.
  - Drop `renderClientsSection` and `/api/care/clients` as a second section. Keep the API only for the client page.
  - 11 Q1 is merged into 10 Q1 (Q-B). With the default "Manager access", 10 also edits 08's order-page FAQ 5 and welcome email, and 01's landing guarantee paragraph, to add "Your 90 days start the day you give us access to your Google Business Profile."

**23. Care uses onboarding-form keys and a Google-access flow that 09 doesn't build.**
- **Where:** 10 (`form.main_service`, `form.town`, `contact_name`; Template A asks for Google access after go-live; "I'm a Manager" tick on the client page) vs 09 (`services[]`, `areas[0]`, `research.owner.first`; the form already sends the Google invite steps; `build:<id>:gbp` todo closed by an "Invite accepted" checkbox).
- **Resolution — 09's keys win.**
  - 10 Tasks 11–13: service = first ticked `services[].name`, town = `areas[0]`, contact = `research.owner.first`.
  - 09's "Invite accepted" checkbox calls 10's `access` action (sets `gbp_access_on`).
  - 10 sends Template A only when `form.gbp.invite_sent` is false, and skips `pre.access_email` otherwise.

**24. Care sends client email its own way.**
- **Where:** 10 Task 11 `sendCareEmail` requires a system mailbox and fails with "role: client mail"; 08/09 `sendClientMail` falls back to a cold mailbox and owns `setup:system_mailbox`.
- **Resolution:** 10 Task 11's `sendCareEmail` wraps 08's `sendClientMail`. Delete 10's own mailbox lookup and its "role: client mail" error.

**25. Care's assumptions about Money and inbound mail aren't met by earlier stages.**
- **Gap 1:** 10 cross-stage says Money excludes `working_free` retainers, but no task does it. Fix: 10 adds a task that modifies `money.js` `loadMoney`/forecast to skip clients whose `care.guarantee = 'working_free'`, plus a test.
- **Gap 2:** 10 assumes inbound client mail has `messages.client_id`, but 01 and 07 never set it. Fix: 07 Task 6 `onHumanInbound` sets `messages.client_id` (`clients.id` by `place_id`) when the prospect is `won`. 01's linking also matches `From` against `client_links.email`.

**26. Failed follow-ups are retried automatically.**
- **Where:** 06 Task 8 `retryFailed` re-queues failed follow-ups up to 3 times. 01 says nothing is retried automatically: a send stuck in `sending` may already have gone.
- **Resolution:** 06 Task 8 retries only rows whose `error` is not 01's "The send was interrupted…" text. On that text it stops the sequence and adds the `health:followup-fail` todo. Add a test.

**27. Claude's reply links use the Control Room's host.**
- **Where:** 07 Task 9 builds demo/order links from a new `app_url` setting (test: `https://control.aetoswebsites.com/d/…`), and the reply checks allow that host. 05's links are `demoLink(slug)` on `https://aetoswebsites.com`.
- **Resolution — 05 wins.** 07 uses `demoLink(slug)` and `${DEMO_BASE}/d/<slug>/order`; the reply checks allow `aetoswebsites.com` only. Drop the `app_url` setting and update 07's tests.

**28. Extras are shown before they exist.**
- **Where:** 07 `offerFacts.included` always lists "A chat assistant…" and review booster lines; 01's landing "What you get"/price bullets always list the review booster. 08 shows them only when `offer:chatbot_live`/`offer:review_booster_live` is `'1'`.
- **Resolution — 08's switches win.**
  - 07 Task 2: `offerFacts(at, {chatbot, reviews})` with flags from those settings.
  - 01 Task 22: `renderLanding` gets the same flags and hides "Review booster" and "More reviews, the honest way" until the switch is on.

**29. The ready prospect isn't made when research arrives.**
- **Where:** 05 says stage 2 calls `ensureDemo` at `POST /api/agent/leads/:id`, which 03 removed; no task wires it.
- **Resolution:** 05 Task 8 also modifies `api/agent/research/[id].js` to call `ensureDemo(DB, placeId, now)` after `saveResearch`, plus a test. Fix the route path in 05's cross-stage line.

**30. Opt-outs and payment interact badly.**
- **Where:** 01 (`opt_out`/`bounce` from any stage, including `won`; `dispatchDue` cancels any kind to a suppressed address; "stage 9 removes the suppression row on payment") vs 08 (never removes it) and 07 (mail from won clients goes to Nik).
- **Conflict:** a paying client's "no thanks" would make them `lost` and silently cancel their welcome and care emails.
- **Resolution:**
  - 01 Task 15: for a prospect in `won`, an `opt_out` class is handled as `human`. Same exception as in item 6.
  - 01 Task 13: check suppression only for `first`/`followup`/`reply`.
  - 08 Task 7: `fulfilCheckout` deletes the `suppression` row for the checkout email, plus a test.

**31. The `hot` flag is defined twice.**
- **Where:** 04 `isHot` (any stage except won/lost) vs 05 `hot.js` `isHot` (only `emailed`/`viewed`).
- **Resolution:** one `isHot` in 04's `shortlist.js` with 05's rule. 04's test case `stage:"replied"` already expects false. 05 Task 12 imports it.

**32. The lead drawer's demo preview frame would be blocked.**
- **Where:** 04 Task 8 frames `/d/<slug>?preview=1`; 05 sets `frame-ancestors 'none'` + DENY and never implements `?preview=1`.
- **Resolution:** 04 uses 05's `/api/demo/preview?template=<id>&place_id=<id>`.

**33. The email-thread link differs.**
- **Where:** 11 `threadLink` → `#/lead/<id>/thread`; 07's todos and pages use `#/replies/<place_id>`.
- **Resolution:** 11 Task 1 `threadLink(id)` → `#/replies/<id>`. Keep `#/lead/<id>/thread` as an alias in `routeFor`.

**34. The Todo page hides every `health` todo, including ones no light covers.**
- **Where:** 11 hides all `health` todos, but 02 (`health:find:*`, `health:stale:*`), 06 (`health:followup-*`) and 10 (day-90 waiting) add actionable ones with no matching light.
- **Resolution:** 11 Task 3 excludes only `health` todos whose dedupe equals `health:<a current light name>`. The rest appear in Today, sorted after `escalation`.

**35. `lost_reason` values don't match what the board expects.**
- **Where:** 11 assumes `opt_out|bounce|said_no|sequence_done`. 07 writes `not_now`, `not_interested`, `call`; 01's test writes "no thanks".
- **Resolution — vocabulary:** `opt_out`, `bounce`, `sequence_done`, `not_now`, `not_interested`, `call`.
  - 01: the `opt_out`/`bounce` events set `lost_reason` to the event name, and the test uses `lost_reason:"opt_out"`.
  - 11 `LOST_WORDS` adds `not_now:"Not right now"`, `not_interested:"Not interested"`, `call:"Said no on the call"`, and drops `said_no`.

**36. 01's health step can close other stages' `setup` todos, and one setup key is a prefix of another.**
- **Where:** 01 Task 17 ("syncs `setup:<key>` todos") vs `setup:` todos from 05 (`demo-template`), 06 (`followups`), 08, 09 and 10. Also `setup:mailbox` is a prefix of `setup:mailbox_password:<id>`, so the password todo is closed and re-added every tick.
- **Resolution:** 01 Task 17 closes only its own keys with an exact match (`WHERE dedupe = ?`), never by prefix. Rename the key `mailbox` → `first_mailbox`.

**37. No tick-wide limit on D1 queries.**
- **Where:** research.md caps D1 at 50 queries per invocation. Step budgets: inbound (10 rows × several queries), followups ≤ 18, hot ≤ 20, daily_find ≤ 14, stale_jobs ≤ 6, care ≤ 20, plus pick, calls, sites and health. Together they exceed 50, and a mid-tick failure stops health.
- **Resolution:**
  - 01 Task 16: `runTick` wraps `DB` in a counter, gives each step `ctx.budget`, never starts a step with fewer than 10 left (it reports `"deferred"`), and always reserves 6 for `health`.
  - 01 Task 15: inbound stops at 30 queries.

**38. The tick-step list in the overview is out of date.**
- **Where:** overview §8 lacks `pick` (04) and `sites` (09); 01 Task 16's comment markers lack them too.
- **Resolution — overview §8 order (`everyMinutes` in brackets):**
  1. inbound (0)
  2. reply_fire (0)
  3. followups (5)
  4. send (0)
  5. hot (5)
  6. pick (30)
  7. daily_find (5)
  8. stale_jobs (15)
  9. calls (5)
  10. sites (5)
  11. care (10)
  12. health (0)
  
  01 Task 16 adds markers for every slot.

**39. Routine prompts ignore 01's Test fire and use four base-URL conventions.**
- **Where:**
  - 01 README requires every `routines/<name>.md` to start with the preamble that stops on "Test from the Control Room…".
  - 03, 07, 09, 10 and 11 omit it. With 10, Test fire runs the full monthly drafting; with 03, a full research run; with 09, a failed heartbeat.
  - The base URL is written as `$CONTROL_ROOM_URL` (03), `{APP_URL}` (07), `{APP}` (09), `CONTROL_ROOM` (10) and `CONTROL_ROOM_URL` (11).
- **Resolution:**
  - 01 Task 8 README step 1 adds the environment variable `CONTROL_ROOM_URL` to the shared "Aetos" environment.
  - Each prompt (03 Task 9, 07 Task 17, 09 Task 29, 10 Task 16, 11 Task 7) starts with 01's preamble verbatim and uses `$CONTROL_ROOM_URL`.
  - Each prompt test asserts the preamble.

**40. The demo page doesn't link the privacy notice.**
- **Where:** 01 Q1's default needs the demo footer to link `https://aetoswebsites.com/privacy` (UK GDPR Art. 14 at first contact); 05's footer doesn't.
- **Resolution:** 05 Task 6 shell, demo mode: footer link "How we use your information" → `https://aetoswebsites.com/privacy`, plus a test.

**41. Nobody builds the 12-month data deletion.**
- **Where:** 01 promises deleting non-customers' details 12 months after last contact and assigns the job to file 11; 11 doesn't build it.
- **Resolution:** 11 adds a task for a tick step `purge`, monthly, run before `health`. It deletes `prospects`/`messages`/`research` rows (keeping `suppression`) for non-clients with no message in 12 months, plus a test.

**42. The demo step closes payment-page "hot" todos.**
- **Where:** 05 closes `hot` todos of prospects that replied or left `emailed`/`viewed`; 08 uses kind `hot` with dedupe `hot:checkout:<place_id>`, which is closed within 5 minutes for a `replied` prospect.
- **Resolution:** 08 renames its dedupe to `checkout:<place_id>`. 05 Task 12 closes only dedupes starting `hot:<place_id>:`.

**43. Care scans are failed by the stale-run step with the wrong message.**
- **Where:** 02 `stale_jobs` fails any `scans` row after 45 min with "Press Run scan…"; 10 wants a 2-hour limit and "Retry the day-N scan".
- **Resolution:** 02 Task 13 skips `source='care'`. 10 Task 11 owns care scans, and 10's `care_scans` light fails them at 45 min with its own text.

---

## MINOR

44. **Two `isSuppressed` functions.** 01 has `isSuppressed(DB,email)` in `prospects.js`; 02 has `isSuppressed(lead, rows)` in `find.js`. Rename 02's to `leadSuppressed` (Tasks 11, 12 and the cross-stage list).
45. **Research fire payload text differs.** Overview §7 `reply waiting: message <id>` vs 07 `reply waiting: <n> message(s)`; 02 `research queued: {n} leads` vs 03 `new leads queued: <n> from job <id>`. 07's and 02's texts win; update overview §7 and 03's Trigger and cross-stage lines.
46. **The "too big" exclusion and `research.py` retirement.** 02's exclusion row "Too big for us (Claude: …)" can never happen (03 stores `too_big` only in `research`), and 03 says stage 1 retires `research.py` `carry_over` while 02 Task 6 still uses it. Fixes: delete 02's exclusion row and its edge case; change 03's sentence to "`carry_over` stays for maps carry-over only".
47. **Timestamps with and without milliseconds.** 02, 05, 06 and 07 use no milliseconds; 04's pick todo and 11's kpi todo use `.toISOString()` with them, which breaks string ordering within the same second. Use `util.now()`/`iso()` everywhere and change 04's and 11's expected values to `…T06:00:00Z`. Use one link format, `/#/…` (11 `kpi` link, `leadLink`).
48. **Sign-off name sources differ.** 06 uses the full mailbox `display_name`, 07 its first word, 08 `display_name`, 10 `{{nik_name}}`. Use the `business:sender_name` setting for every sign-off and cold footer (06 Task 8, 07 Task 5 `signature`, 08 Task 6, 09, 10 `factsFor`).
49. **Routine names in the README differ:** 01 `aetos-<name>` vs "Aetos research/replies/build/monthly care/weekly KPIs". Use 01's `aetos-<name>`, and say "Setup → Claude" everywhere (03, 07, 09 and 10 say "Setup → Routines").
50. **Order button wording.** 08 says "Make it mine" (Trigger, Money hint, cross-stage); 05's button is "Order this site". Use "Order this site" in 08.
51. **Trader line.** 08 needs a trader-line helper; 01 only inlines it. 01 Task 22 exports `traderLine(business) → string|""`, and 08 Task 4 uses it.
52. **CR/LF in subjects.** 09 cross-stage says `composeEmail` strips CR/LF; it throws. Fix the line: "09 strips with `oneLine()` before queueing".
53. **New public paths.** 09 Task 23 adds the public `/w/` and `/s/f/` paths but not to 01's `site.test.mjs`. Add them (01's rule). 09's "routine:build red 3 h after a fire" has no task; move it into the `sites` light as amber "Claude hasn't built {name}'s site".
54. **05's nav entry.** "Demo" under a "Sell" group, but 01's `PAGES` has no groups and 11 removes the item. 05 Task 14 registers the route with no nav item.
55. **Two questions misstate the specs.** 06 Q2 (demo kept 30 days after close) is already met by 05's 180-day rule; delete it. 08 Q3 says "You decided no reminder", which decisions.md doesn't say; reword it.
56. **Mailbox role wording.** 10 says "role: client mail"; roles are `cold|system`. Use "role: System".
57. **The overview contradicts itself.**
    - §3 says `requireAgent(request, DB)` and `capacity.js dailyCap`; §8 says `(request, env, DB)`, `rampCap`/`mailboxCap`. Fix §3.
    - §6 lacks the `kpi` kind (11) and the `pick`/`checkback` use (07).
    - §7 should give `monthly-care` "schedule + API trigger" (10).
    - §10 step 7 should say "API triggers for research, reply, build, monthly-care".
58. **Shared browser helpers are compatible but not written down.** Write in 04's cross-stage list:
    - `public/js/html.js` (04) is the source of `esc`/`safeUrl`/`icon`, and `lib.js` re-exports them (01's test "setup.js imports esc from ./lib.js" still passes).
    - `_lib/session.js` (05) keeps 01's cookie name `cr_session` and token derivation.
59. **KPIs count the wrong things.** "Escalated" counts unknown-sender, client and opt-out escalations; count only dedupes `escalation:` not followed by `unknown:`. `loadKpiRows` and `loadBoard` must exclude `place_id LIKE 'drill:%' OR 'test:%'` (07's rule).
60. **07 repeats helpers from 06.** 07 Task 6 should call 06's `stopFollowups(DB, placeId, "replied", now)` instead of its own cancel; 07 `businessName` should import 06's `mail/rules.js` `businessName`.
61. **Nik's own demo views can count.** On aetoswebsites.com his Control Room cookie (host-only) isn't sent. The drawer's and Demo page's "Open demo" links should be the relative `/d/<slug>` on the Control Room host (05 Task 14, 04 Task 8).
62. **Build guarantee wording.** 08 changes `BUILD_GUARANTEE` to include "(clock starts when your onboarding form is complete)". Keep 01's constant and add `BUILD_GUARANTEE_NOTE` for 08's order page.
63. **A new Cloudflare credential.** 09's chatbot needs a Workers AI token, which goes against overview §2's "no new Cloudflare keys for Nik". Note it in overview §10 as an exception, stored on Setup.

---

## Questions for Nik (deduplicated, with the default the build uses)

| # | Question | Source(s) | Default |
| --- | --- | --- | --- |
| Q-A | Weekend crossed-out price: £1,950 or £2,000? | 08 Q1; conflicts with 01, 04, 07 | ~~£1,950~~ £1,750 in writing; "around £2,000" only when spoken |
| Q-B | When does the 90-day guarantee clock start? | 10 Q1, 11 Q1 (contradicting) | The day Nik becomes Manager on their Google profile; order page and welcome email say so |
| Q-C | How big is "their area" for Top 3? | 10 Q2 | 7×7 points 800 m apart; Top 3 at their address and in at least half the points |
| Q-D | How replies reach Cloudflare | D-1, 01 Q4, decisions waiting #2 | Option A: a ~£5/yr receive-only domain |
| Q-E | Cloudflare $5/month plan | D-2 | Free plan until the SMTP test fails |
| Q-F | "How much is it?" in Nik's words | D-3, decisions #3 | Claude answers from `offer.js` in his style |
| Q-G | "Send me more info" link | D-4, decisions #4 | Their demo, with aetoswebsites.com named under it |
| Q-H | Landscaper template look | D-5 | Claude designs v1; Nik approves before any email |
| Q-I | Chatbot: own build or Elfsight | D-6 | Own (Workers AI), behind `offer:chatbot_live` |
| Q-J | Business address in footers | D-7 | Setup field; red banner until filled |
| Q-K | Follow-up days 1, 2, 4, 7, 10, 17, 24, 30, 60 | decisions #1 | As listed |
| Q-L | Send first emails before the 9 follow-ups are approved? | 06 Q1 | Yes, with a warning |
| Q-M | Skip bank holidays? | 06 Q3 | No |
| Q-N | Privacy notice at first contact | 01 Q1 | Demo footer links /privacy; email keeps one link |
| Q-O | Keep the landing "free preview" promise? | 01 Q2 | Keep |
| Q-P | Data retention for non-buyers | 01 Q3 | 12 months, purge built in file 11 |
| Q-Q | When the 18 towns are used up | 02 Q1 | Pause plus "Add more towns" todo |
| Q-R | Hide too-big leads? | 03 Q1 | Visible as D with a "Too big" tag |
| Q-S | Re-checks jump the queue? | 03 Q2 | Yes |
| Q-T | Write first emails for tomorrow when today is full? | 04 Q1 | No |
| Q-U | CSV download on Leads | 04 Q2 | Dropped |
| Q-V | Price on the demo? | 05 Q1 | No; prices only on the order page |
| Q-W | Approve each demo before its first email? | 05 Q2 | No; one approval per template |
| Q-X | Pale brand colour | 05 Q3 | Darker shade, then Charcoal |
| Q-Y | "Another time" asked after 5pm | 07 Q1 | "by tomorrow evening"; todo due 6pm tomorrow |
| Q-Z | Said no or not now, then writes back keen | 07 Q2 | Claude answers; stage goes back to replied (`reopen`) |
| Q-AA | Unclear and "are you a person?" replies | 07 Q3 | Go to Nik with a draft |
| Q-AB | Nudge after a reply goes quiet? | 07 Q4 | None |
| Q-AC | Website Only ongoing costs (hosting and domain renewal) | 08 Q2 + 09 Q2 | Hosting free for good; we pay year 1 of the domain, then it renews at their cost with a month's notice |
| Q-AD | Remind clients before the free days end? | 08 Q3 | Off |
| Q-AE | Stripe invoices for Website Only | 08 Q4 | On |
| Q-AF | Title tag length and "BEST" | 09 Q1 | Up to 120 characters, no "BEST" |
| Q-AG | Client sign-off before go-live? | 09 Q3 | No; Nik approves |
| Q-AH | Approve each of the 12 weekly client emails? | 10 Q3 | Yes |
| Q-AI | Foursquare listing ($20 per client) | 10 Q4 | Skip |
| Q-AJ | Referral reward | 10 Q5 | None |
| Q-AK | Review booster: does the system send the "job finished" message, or does the client? (decisions.md: "A message sent when each job finishes, plus one reminder") | New (09 §12 vs decisions) | The client sends it, using our ready-made text, email and QR templates; nothing automated |

---

# Round 2 (final check after the fixes)

Reconciliation items 1–43 are all applied in the files. The problems below are new ones, or places where a fix only partly landed.

**BLOCKING**

1. **02 Task 10 vs 03 Tasks 4–6, 08 (Global Constraints), 10 Task 11, 11 Tasks 3/6/12: `iso()` is defined in the wrong file.** 02 defines `iso(date)` in `_lib/find.js`, but 03/08/10/11 import `iso` from `_lib/util.js`, which only exports `now()`, so those imports fail to load. **Fix:** in 02 Task 10, add `export const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z")` to `_lib/util.js`. `find.js` imports and re-exports it, and 04 Task 6 imports it from `util.js`.

2. **01 Task 16 vs 05 Task 12, 06 Task 8, 10 Task 11, 11 Task 12: `ctx.budget` has two shapes.** 01 defines it as an object read with `budget.left()` (01 Task 15 calls `ctx.budget.left()`). 06 (`min(18, ctx.budget)`), 10 (test "ctx.budget at 12") and 11 (`ctx.budget - 2`, tests pass `budget: 30`) treat it as a number. Their tests would pass while the live tick does maths on an object (NaN). **Fix:** every step calls `ctx.budget.left()`, and tests pass `budget: {left: () => N}`. In 11 Task 12: `maxRounds = Math.min(5, Math.floor((ctx.budget.left() - 2) / 4))`.

3. **06 Task 8, "bounded work" test: wrong `countingDB` shape.** The test passes `countingDB(DB)` as the DB and reads `.calls`, but 01's `countingDB` returns `{DB, used}`. **Fix:** `const c = countingDB(DB); await followupsStep({DB: c.DB, env: {}, now}); assert.ok(c.used() <= 18)`.

4. **01 Task 23 (`shell.test.mjs`), 04 Task 8, 05 Task 14, 06 Task 14, 07 Tasks 15–16, 11 Task 11: routing breaks between stage 3 and file 11.**
   - 01's test asserts the `PAGES` routes are exactly the 5 stage-0 ones. 05, 06 and 07 add routes and 11 removes `PAGES`, and nothing updates the test, so it fails from 05 Task 14 on.
   - 04 makes `app.js` route through `leadview.js` `parseRoute`, whose page list is hard-coded (unknown → home). No later stage extends it, so `#/demo`, `#/voice`, `#/replies` and `#/call` open Home until file 11 ships.
   - **Fix:** 01's test asserts the 5 routes are present (not an exact match) plus no roadmap/outreach/"soon". 11 Task 11 deletes that assertion. 04's `parseRoute` returns the first hash segment as `page` for any route (keeping `lead/<id>` → leads) and lets `app.js` `PAGES.find` handle unknown pages. 05 Task 14 and 07 Task 16 add their `PAGES` entries with `nav: false`.

5. **10 Task 18 vs 11 Task 2 and the existing `public/js/money.js`: new status key with no renderer.** 10 adds the `clientStatus` key `working_free` but only edits `_lib/money.js`. The Money page renders status with `{…}[c.key]()`, so it throws for that client, and `clientCards` has no "Monthly" wording for the key. **Fix:** 10 Task 18 also adds `working_free` to `public/js/money.js` (label "Working free: fee paused", keep the "Stopped paying" button) and to 11's `clientCards` Monthly line ("Fee paused: working free"), with tests.

6. **10 Task 15 (Interfaces and cross-stage list): `loadBoard` signature mismatch.** 10 says `loadBoard(DB, now)`; 11 Task 3 defines `loadBoard(DB, env, now)`. **Fix:** change 10's references and tests to `loadBoard(DB, env, now)`.

**IMPORTANT**

7. **01 Tasks 16–17: the health step can't fit in its 6 reserved queries.** It loads stage-0 facts, runs about 10 registered lights (each querying D1), syncs one todo per light and the setup keys, then writes a heartbeat. That is far more than 6, and because `health` always runs, a tick can go over D1's 50-query limit. **Fix:** run `health` in its own invocation (the relay cron also calls `/api/tick?reason=health`, which runs only `health`), or set `healthReserve` to the measured count. Cap each registered light at 1 statement, sync todos with one INSERT OR IGNORE batch plus one `UPDATE … WHERE dedupe IN (…)`, and assert the count in `health.test`.

8. **08 Task 1 / 08 Task 11 / 11 Task 10: `paymentLinks` deleted, then reused.**
   - 08 Task 1 deletes `paymentLinks`/`linksCard` from `public/js/money.js`, but stage 0's `setup.js` still imports `paymentLinks` until 08 Task 11, so the Setup page fails to load in between.
   - 11 Task 10 then specifies `paymentLinks(links, packages)` and "drop local PACKAGES/24900", which 08 already removed. That leaves two package sources: 08's `summary.packages` and 11's `getOffer()`.
   - **Fix:** 08 Task 1 also removes that import and the old Stripe card from `setup.js`. 11 Task 10 drops the `paymentLinks` bullet and cross-stage line, and says whether `getOffer()` replaces `summary.packages`.

9. **08 Part A FAQ 5 and 10 Task 19: old guarantee wording.** Both keep "we work for free until you are", which overview §9 forbids and 04 Task 7's test bans. **Fix:** FAQ 5 = "…The map results at the top count. " + `GUARANTEE.section` + " " + `CLOCK_START`. Add `doesNotMatch(/work for free until you are/)` to `order-page.test`.

10. **08 Task 6 vs 09 Tasks 16/24/26: wrong todo when there's no mailbox.** With no mailbox, `sendClientMail` always files `setup:welcome:<client_id>` ("Send {name} their onboarding link yourself"). 09's enquiry, domain and go-live emails get that wrong title, or are swallowed by the same dedupe. **Fix:** add an option `noMailboxTodo: {dedupe, title} | null` (default = the welcome todo). 09 passes `null` for enquiries and `{dedupe: "setup:client-mail:<client_id>:<kind>", title: "Send {name} this email yourself (no mailbox yet)"}` for the others.

11. **10 R1 / Task 11 vs 09 §5: the guarantee keyword differs from the site's keyword.** 10 sets `care.keyword` = first ticked service + town (e.g. "patios warrington"). 09's site targets `content.keyword` and `primary_category` (H1 "<Primary category> in <Town>"). So the guarantee is measured on a keyword the site wasn't built for, and `w5.onpage_check` ("H1 has service + town") fails on every 09-built site. **Fix:** `loadCareState` takes service and town from `client_sites.content.keyword` when it is set, otherwise the first ticked service. `onPageCheck` also accepts `primary_category` in the title and H1.

12. **02 Task 12, "tick order" test: asserts a step that doesn't exist yet.** It asserts `daily_find` comes before `stale_jobs`, but `stale_jobs` is only added in Task 13, so Task 12 Step 4 can't pass. **Fix:** move that assertion into Task 13's `stale-jobs` test.

13. **01 Task 6, "no other module hard-codes a price" test: fails on existing code.** The regex already matches the existing comment `"£1,950.00" → 195000` in `_lib/money.js` (about line 222). **Fix:** Task 6 also rewrites that comment, or the test strips comments first.

14. **Overview §7 table and §10 step 7 vs 01 Task 17 and 11 Task 7: weekly-kpis API trigger.** The overview says weekly-kpis has no API trigger. But 01's setup gaps and the `routine:weekly-kpis` light require its URL and token, and 11 creates the trigger. If Nik follows §10, Setup never shows complete. **Fix:** overview §7 → "schedule Sun 18:47 + API trigger (Test fire)"; §10 step 7 lists research, reply, weekly-kpis, build and monthly-care.

15. **11 Tasks 3 and 6: client and unknown-sender escalations.**
   - 01's `escalation:client:<id>` and `escalation:unknown:<id>` todos (no draft, no thread) get a Send button, and `messageIdFromDedupe` returns "client:…" or "unknown:…", so Send gets a 404.
   - The "Escalated" KPI counts `escalation:client:` todos as Claude escalations.
   - **Fix:** `messageIdFromDedupe` returns null for those two prefixes, and Send/Edit render only when `draft` is set and an id was parsed. `loadKpiRows` also excludes `escalation:client:`, with a test row.

16. **01 "Needed from other stages" vs 09: the landing page's chatbot line is never written.** 01 hands this to 09, but no 09 task edits `_lib/site.js`, so `extras.chatbot` is never used. **Fix:** add to 09 Task 27: when `extras.chatbot` is on, `renderLanding` shows the chatbot line under "What you get" and in the Full Package bullets, tested in `site.test.mjs`.

**Decisions on round 2, which override the fix text above where they differ:**
- **R2-7:** run health on its own invocation. The relay's `scheduled()` makes two calls every 5 minutes: `/api/tick`, then `/api/tick?reason=health`.
  - `runTick` with `reason === "health"` runs only the `health` step, with the full 50-query budget.
  - Every other reason skips `health`.
  - Drop the "6 reserved for health" rule.
  - The health step still batches its todo sync: one INSERT OR IGNORE batch and one UPDATE … WHERE dedupe IN (…).
- **R2-8:** the Money page keeps using 08's `summary.packages`. Other pages use 11's `getOffer()`. Both are serialisations of `offer.js`, so there is one source of truth.
