-- Todo board seed (docs/rebuild/11-todo-kpis.md, Task 3): the Task 1 pipeline (9 prospects, every stage, one hot
-- lead), a ready drill lead that must never show, the Task 2 clients, one mailbox, pn's escalated email and the Todo
-- items todo-api.test.mjs checks. Times are for NOW = 2026-10-22T12:00:00Z (Thu 22 Oct 2026, 13:00 UK).
--
-- Tests: DB.exec() it on a fresh fakeD1(). Live: npx wrangler d1 execute DB --local --file
-- control-room/tests/fixtures/board-seed.sql under wrangler pages dev; the Todo page shows the same counts.

INSERT INTO settings (key, value) VALUES ('business:sender_name', 'Nik');

INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at)
VALUES ('mb1', 'nik@aetoswebsites.com', 'Nik', 'cold', '2026-09-01', '2026-09-01T09:00:00Z');

INSERT INTO leads (place_id, name, trade, search_town, town, phone, first_seen_at, updated_at) VALUES
  ('pr',  'Riverside Plumbing',    'plumber',           'Warrington', 'Warrington', '01925 100001', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pe',  'Elm Electrical',        'electrician',       'Warrington', 'Warrington', '01925 100002', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pv',  'Valley Heating',        'heating engineer',  'Warrington', 'Warrington', '01925 100003', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('ph',  'Hilltop Roofing',       'roofer',            'Warrington', 'Warrington', '01925 100004', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('prp', 'Peak Removals',         'removals',          'Warrington', 'Warrington', '01925 100005', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pn',  'North Locksmiths',      'locksmith',         'Warrington', 'Warrington', '01925 100006', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pc',  'Castle Car Sales',      'car dealer',        'Warrington', 'Warrington', '01234 567890', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pw',  'Westside Mechanics',    'mechanic',          'Warrington', 'Warrington', '01925 100008', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('pl',  'Lakeside Pest Control', 'pest control',      'Warrington', 'Warrington', '01925 100009', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
  ('drill:1', 'Drill Test Roofing', 'roofer',           'Warrington', 'Warrington', '01925 100010', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z');

INSERT INTO prospects (place_id, stage, stage_at, email, mailbox_id, subject, first_sent_at, followup_step, next_followup_at,
    views, last_view_at, last_inbound_at, lost_reason, created_at, updated_at) VALUES
  ('pr',  'ready',       '2026-10-22T08:00:00Z', 'mark@riverside-plumbing.co.uk', NULL, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, '2026-10-22T08:00:00Z', '2026-10-22T08:00:00Z'),
  ('pe',  'emailed',     '2026-10-20T08:00:00Z', 'dave@elm-electrical.co.uk', 'mb1', 'Your new website', '2026-10-20T08:00:00Z', 0, '2026-10-23T07:00:00Z', 0, NULL, NULL, NULL, '2026-10-19T08:00:00Z', '2026-10-20T08:00:00Z'),
  ('pv',  'viewed',      '2026-10-20T09:00:00Z', 'info@valleyheating.co.uk', 'mb1', 'Your new website', '2026-10-19T08:00:00Z', 0, '2026-10-24T07:00:00Z', 1, '2026-10-20T09:00:00Z', NULL, NULL, '2026-10-18T08:00:00Z', '2026-10-20T09:00:00Z'),
  ('ph',  'viewed',      '2026-10-19T09:00:00Z', 'jo@hilltoproofing.co.uk', 'mb1', 'Your new website', '2026-10-18T08:00:00Z', 2, '2026-10-25T08:00:00Z', 3, '2026-10-21T20:00:00Z', NULL, NULL, '2026-10-17T08:00:00Z', '2026-10-21T20:00:00Z'),
  ('prp', 'replied',     '2026-10-22T09:30:00Z', 'pete@peakremovals.co.uk', 'mb1', 'Your new website', '2026-10-15T08:00:00Z', 1, NULL, 1, '2026-10-16T10:00:00Z', '2026-10-22T09:30:00Z', NULL, '2026-10-14T08:00:00Z', '2026-10-22T09:30:00Z'),
  ('pn',  'needs_nik',   '2026-10-21T16:05:00Z', 'sam@northlocksmiths.co.uk', 'mb1', 'Your new website', '2026-10-14T08:00:00Z', 2, NULL, 0, NULL, '2026-10-21T16:00:00Z', NULL, '2026-10-13T08:00:00Z', '2026-10-21T16:05:00Z'),
  ('pc',  'call_booked', '2026-10-21T11:00:00Z', 'ian@castlecarsales.co.uk', 'mb1', 'Your new website', '2026-10-12T08:00:00Z', 1, NULL, 2, '2026-10-13T10:00:00Z', '2026-10-21T10:30:00Z', NULL, '2026-10-11T08:00:00Z', '2026-10-21T11:00:00Z'),
  ('pw',  'won',         '2026-10-15T14:00:00Z', 'gary@westsidemechanics.co.uk', 'mb1', 'Your new website', '2026-10-05T08:00:00Z', 1, NULL, 4, '2026-10-14T18:00:00Z', '2026-10-15T09:00:00Z', NULL, '2026-10-04T08:00:00Z', '2026-10-15T14:00:00Z'),
  ('pl',  'lost',        '2026-10-21T10:00:00Z', 'office@lakesidepest.co.uk', 'mb1', 'Your new website', '2026-10-16T08:00:00Z', 1, NULL, 0, NULL, '2026-10-21T10:00:00Z', 'opt_out', '2026-10-15T08:00:00Z', '2026-10-21T10:00:00Z'),
  ('drill:1', 'ready',   '2026-10-22T08:00:00Z', 'drill@example.com', NULL, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, '2026-10-22T08:00:00Z', '2026-10-22T08:00:00Z');

INSERT INTO research (place_id, status, grade, queued_at, researched_at) VALUES
  ('pr', 'done', 'A', '2026-10-21T06:47:00Z', '2026-10-21T07:10:00Z'),
  ('ph', 'done', 'B', '2026-10-16T06:47:00Z', '2026-10-16T07:10:00Z');

-- Sent outbound mail behind each card's last event (pe, pv, ph), and pn's email that Claude escalated to Nik.
INSERT INTO messages (id, place_id, mailbox_id, direction, kind, step, author, to_addr, from_addr, subject, body, message_id,
    status, due_at, sent_at, created_at) VALUES
  ('m-pe1', 'pe', 'mb1', 'out', 'first', NULL, 'nik', 'dave@elm-electrical.co.uk', 'nik@aetoswebsites.com', 'Your new website', 'Hi Dave, I built you a site.', '<m-pe1@aetoswebsites.com>', 'sent', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z', '2026-10-20T07:55:00Z'),
  ('m-pv1', 'pv', 'mb1', 'out', 'first', NULL, 'nik', 'info@valleyheating.co.uk', 'nik@aetoswebsites.com', 'Your new website', 'Hi, I built you a site.', '<m-pv1@aetoswebsites.com>', 'sent', '2026-10-19T08:00:00Z', '2026-10-19T08:00:00Z', '2026-10-19T07:55:00Z'),
  ('m-ph1', 'ph', 'mb1', 'out', 'first', NULL, 'nik', 'jo@hilltoproofing.co.uk', 'nik@aetoswebsites.com', 'Your new website', 'Hi Jo, I built you a site.', '<m-ph1@aetoswebsites.com>', 'sent', '2026-10-18T08:00:00Z', '2026-10-18T08:00:00Z', '2026-10-18T07:55:00Z'),
  ('m-ph3', 'ph', 'mb1', 'out', 'followup', 2, 'system', 'jo@hilltoproofing.co.uk', 'nik@aetoswebsites.com', 'Re: Your new website', 'Just checking you saw it.', '<m-ph3@aetoswebsites.com>', 'sent', '2026-10-21T07:00:00Z', '2026-10-21T07:00:00Z', '2026-10-21T06:55:00Z');

INSERT INTO messages (id, place_id, mailbox_id, direction, kind, author, to_addr, from_addr, subject, body, message_id,
    status, received_at, class, needs_reply, handled_at, intent, created_at) VALUES
  ('m-pn1', 'pn', 'mb1', 'in', 'inbound', 'them', 'nik@aetoswebsites.com', 'sam@northlocksmiths.co.uk', 'Re: Your new website',
   'Who gave you my email? Stop emailing me.', '<m-pn1@northlocksmiths.co.uk>', 'received', '2026-10-21T16:00:00Z', 'human', 0,
   '2026-10-21T16:05:00Z', 'angry', '2026-10-21T16:00:00Z');

INSERT INTO calls (id, place_id, slot_at, status, phone, created_at, updated_at)
VALUES ('call-pc', 'pc', '2026-10-23T10:00:00Z', 'confirmed', '07969 123456', '2026-10-21T11:00:00Z', '2026-10-21T11:00:00Z');

-- The Task 2 clients: c1 building (2 days left), c2 live with a Map Rank scan, c3 late, c4 stopped, c5 card failed,
-- c6 website only.
INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, cancelled_on, created_at) VALUES
  ('c1', 'Green Leaf',         'lp1', 'full',    195000, 24900, 60, '2026-10-15', NULL,         '2026-10-15T10:00:00Z'),
  ('c2', 'Diamond Kickboxing', 'lp2', 'full',    195000, 24900, 60, '2026-07-01', NULL,         '2026-07-01T10:00:00Z'),
  ('c3', 'Ace Roofing',        'lp3', 'weekend', 175000, 24900, 90, '2026-10-10', NULL,         '2026-10-10T10:00:00Z'),
  ('c4', 'Old Client',         'lp4', 'full',    195000, 24900, 60, '2026-03-01', '2026-10-01', '2026-03-01T10:00:00Z'),
  ('c5', 'Bright Sparks',      'lp5', 'full',    195000, 24900, 60, '2026-07-20', NULL,         '2026-07-20T10:00:00Z'),
  ('c6', 'Quick Locks',        'lp6', 'website', 175000, 0,      0, '2026-10-01', NULL,         '2026-10-01T10:00:00Z');

INSERT INTO onboarding (client_id, token, status, due_live_at, live_at, created_at) VALUES
  ('c1', 'tok-c1', 'building', '2026-10-24T16:00:00Z', NULL,                   '2026-10-15T10:00:00Z'),
  ('c2', 'tok-c2', 'live',     '2026-08-30T16:00:00Z', '2026-09-01T10:00:00Z', '2026-07-01T10:00:00Z'),
  ('c3', 'tok-c3', 'review',   '2026-10-20T16:00:00Z', NULL,                   '2026-10-10T10:00:00Z'),
  ('c4', 'tok-c4', 'live',     NULL,                   '2026-03-10T10:00:00Z', '2026-03-01T10:00:00Z'),
  ('c5', 'tok-c5', 'live',     NULL,                   '2026-09-27T09:00:00Z', '2026-07-20T10:00:00Z'),
  ('c6', 'tok-c6', 'live',     NULL,                   '2026-10-08T09:00:00Z', '2026-10-01T10:00:00Z');

INSERT INTO client_links (client_id, stripe_customer, stripe_subscription, email, failed_on) VALUES
  ('c5', 'cus_seed5', 'sub_seed5', 'owner@brightsparks.co.uk', '2026-10-21');

INSERT INTO lead_map_rank (place_id, scan_id, keyword, town, avg_rank, top3_pct, found_pct, updated_at)
VALUES ('lp2', 's1', 'kickboxing', 'Warrington', 2.8, 64, 90, '2026-10-20T06:00:00Z');

-- Todo items. t-health is hidden (the tick light shows it: the seed has no tick heartbeat, so that light is red);
-- t-done is closed; t-drill belongs to a drill lead. Everything else shows.
INSERT INTO todos (id, kind, place_id, client_id, title, detail, link, draft, due_at, status, dedupe, created_at, done_at) VALUES
  ('t-esc', 'escalation', 'pn', NULL, 'Angry reply from North Locksmiths: Claude''s draft is ready',
   'They wrote: "Who gave you my email? Stop emailing me."', '/#/replies/pn',
   'Hi Sam, sorry about that. You won''t hear from me again.', '2026-10-22T10:00:00Z', 'open', 'escalation:m-pn1', '2026-10-21T16:05:00Z', NULL),
  ('t-call', 'call', 'pc', NULL, 'Call Ian at Castle Car Sales', 'Booked by Claude: they want a price for the full package.',
   '/#/call/call-pc', NULL, '2026-10-23T10:00:00Z', 'open', 'call:call-pc', '2026-10-21T11:00:00Z', NULL),
  ('t-hot', 'hot', 'ph', NULL, 'Hilltop Roofing keeps opening their demo', 'Viewed it 3 times. Give them a ring.',
   '/#/lead/ph', NULL, NULL, 'open', 'hot:ph:2026-10-22', '2026-10-21T20:05:00Z', NULL),
  ('t-pay', 'payment', NULL, 'c5', 'Bright Sparks'' card failed', 'Their monthly payment failed on 21 Oct. Stripe retries it.',
   '/#/money', NULL, '2026-10-21T09:00:00Z', 'open', 'payment:c5:2026-10-21', '2026-10-21T09:00:00Z', NULL),
  ('t-setup', 'setup', NULL, NULL, 'Choose the demo site''s look', 'Pick a template on the Demo page.',
   '/#/demo', NULL, NULL, 'open', 'setup:demo-template', '2026-10-20T09:00:00Z', NULL),
  ('t-gone', 'hot', 'deleted-lead', NULL, 'A lead that keeps opening their demo', 'Viewed it twice.',
   NULL, NULL, NULL, 'open', 'hot:deleted-lead:2026-10-21', '2026-10-21T09:00:00Z', NULL),
  ('t-health', 'health', NULL, NULL, 'The 5-minute check has stopped', 'Check the relay light.',
   '/#/setup', NULL, NULL, 'open', 'health:tick', '2026-10-22T09:00:00Z', NULL),
  ('t-find', 'health', NULL, NULL, 'The daily search has run out of towns', 'Add more towns on the Lead Scraper page.',
   '/#/scraper', NULL, NULL, 'open', 'health:find:towns', '2026-10-22T06:00:00Z', NULL),
  ('t-kpi', 'kpi', NULL, NULL, 'Claude''s email review for 19–25 Oct: 2 suggestions', 'Read it and pick what to try.',
   '/#/kpis?week=2026-W43', NULL, '2026-10-26T08:00:00Z', 'open', 'kpi:2026-W43', '2026-10-25T18:50:00Z', NULL),
  ('t-done', 'hot', 'pe', NULL, 'Elm Electrical opened their demo', '', '/#/lead/pe', NULL, NULL, 'done', 'hot:pe:2026-10-20',
   '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z'),
  ('t-drill', 'hot', 'drill:1', NULL, 'Drill lead keeps opening their demo', '', '/#/lead/drill:1', NULL, NULL, 'open',
   'hot:drill:1:2026-10-22', '2026-10-22T08:00:00Z', NULL);
