// The hand-checked KPI week (docs/rebuild/11-todo-kpis.md Part A, "Hand-checked week"): week 2026-W43 = Mon 19 –
// Sun 25 Oct 2026, BST until 02:00 on the 25th. Shared by kpis.test.mjs (Task 5), kpis-api.test.mjs (Task 6, which
// inserts these rows into the real tables) and the KPIs page tests (Task 9). Not a test file itself.
//
// `rows` is computeWeek's input shape. Ids, times, kinds, classes and intents are the spec table's, verbatim. Messages
// also carry `due_at` and `created_at` (the messages table needs created_at; m7 is queued with only a due time) so a
// seeder can insert them as they are. A first email's step is NULL, as stage 6 stores it (step 0 on the KPIs page).
// The escalation todo carries its `dedupe`. Grades: p0 B, p1 A+, p2 A, p3 A, p4 B, p5 A.
//
// Every business and person is invented. Two inbound bodies hold a phone number (Ofcom's drama range) and an email
// address, so Task 6's samples can prove they're removed.
//
// Deep-frozen: build changed copies ({ ...rows, messages: [...] }), never write into it.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

const DEMO = (slug) => `https://aetoswebsites.com/d/${slug}`;

const out = (id, place_id, kind, step, author, status, time, subject, body) => ({
  id, place_id, direction: "out", kind, step, author, status, class: null, intent: null,
  sent_at: status === "sent" ? time : null, received_at: null, due_at: time, created_at: time, subject, body,
});

const inbound = (id, place_id, time, cls, intent, subject, body) => ({
  id, place_id, direction: "in", kind: "inbound", step: null, author: "them", status: "received", class: cls, intent,
  sent_at: null, received_at: time, due_at: null, created_at: time, subject, body,
});

const first = (id, place_id, time, slug, name) =>
  out(id, place_id, "first", null, "nik", "sent", time, `A website for ${name}`,
    `Hi,\n\nI put together a quick website for ${name} so you can see how it could look:\n${DEMO(slug)}\n\nHave a look and tell me what you think.\n\nNik\nAetos Websites`);

export const rows = deepFreeze({
  messages: [
    first("m0", "p0", "2026-10-18T22:30:00Z", "p0-heating", "Brook Heating"),   // UK Sun 23:30 BST: week 42
    first("m5", "p5", "2026-10-18T23:30:00Z", "p5-removals", "Hartley Removals"), // UK Mon 00:30 BST: week 43
    first("m1", "p1", "2026-10-19T08:00:00Z", "p1-roofing", "Ashdown Roofing"),
    first("m2", "p2", "2026-10-19T08:05:00Z", "p2-plumbing", "Fenwick Plumbing"),
    first("m3", "p3", "2026-10-19T08:10:00Z", "p3-electrics", "Larch Electrics"),
    first("m4", "p4", "2026-10-19T08:15:00Z", "p4-locks", "Moss Locksmiths"),
    inbound("i1", "p4", "2026-10-19T08:16:00Z", "bounce", null, "Undeliverable: A website for Moss Locksmiths",
      "Delivery has failed to these recipients or groups. The email address couldn't be found."),
    out("m6", "p2", "followup", 1, "system", "sent", "2026-10-20T08:00:00Z", "Re: A website for Fenwick Plumbing",
      `Hi,\n\nJust checking this reached you. Your demo site is here:\n${DEMO("p2-plumbing")}\n\nNik\nAetos Websites`),
    out("m8", null, "system", null, "system", "sent", "2026-10-20T09:00:00Z", "Mailbox check",
      "A system email with no lead: never counted."),
    inbound("i2", "p1", "2026-10-20T10:00:00Z", "human", "interested", "Re: A website for Ashdown Roofing",
      "Looks good mate. How does it work? Ring me on 07700 900123 if easier."),
    out("c1", "p1", "reply", null, "claude", "sent", "2026-10-20T10:12:00Z", "Re: A website for Ashdown Roofing",
      "Thanks, glad you like it. It takes 7 days to go live once you've filled in a short form. Shall we have a quick call this week to go through it?\n\nNik\nAetos Websites"),
    inbound("i3", "p1", "2026-10-20T15:00:00Z", "human", "proposes_time", "Re: A website for Ashdown Roofing",
      "Thursday at 11 works for me."),
    out("m7", "p6", "first", null, "nik", "queued", "2026-10-21T08:00:00Z", "A website for Kestrel Pest Control",
      `Hi,\n\nI put together a quick website for Kestrel Pest Control:\n${DEMO("p6-pest")}\n\nNik\nAetos Websites`),
    inbound("i4", "p3", "2026-10-21T07:00:00Z", "human", "not_interested", "Re: A website for Larch Electrics",
      "Not for me thanks, I'm busy enough."),
    out("c2", "p3", "reply", null, "claude", "sent", "2026-10-21T07:04:00Z", "Re: A website for Larch Electrics",
      "No problem at all, thanks for letting me know. Good luck with the work.\n\nNik\nAetos Websites"),
    inbound("i5", "p5", "2026-10-22T23:00:00Z", "human", "price", "Re: A website for Hartley Removals",
      "How much is it? Send the details to sam.hartley@hartley-removals.example please."),
    out("c3", "p5", "reply", null, "claude", "sent", "2026-10-23T06:00:00Z", "Re: A website for Hartley Removals",
      "It's around £2,000 for the site, live in 7 days, and the first 60 days of the monthly side are free. You can order straight from your demo page.\n\nNik\nAetos Websites"),
    inbound("i6", "p2", "2026-10-24T10:00:00Z", "opt_out", null, "Re: A website for Fenwick Plumbing", "No thanks."),
  ],
  views: [
    { place_id: "p1", at: "2026-10-19T12:00:00Z" },
    { place_id: "p1", at: "2026-10-20T09:00:00Z" },
    { place_id: "p2", at: "2026-10-20T09:00:00Z" },
    { place_id: "p5", at: "2026-10-27T00:00:00Z" },
  ],
  calls: [
    { place_id: "p1", status: "confirmed", created_at: "2026-10-20T15:05:00Z" },
    { place_id: "p9", status: "offered", created_at: "2026-10-21T09:00:00Z" },
  ],
  orders: [
    { place_id: "p5", paid_on: "2026-10-24", build_fee_pence: 175000 },
  ],
  grades: { p0: "B", p1: "A+", p2: "A", p3: "A", p4: "B", p5: "A" },
  research: [
    { place_id: "p1", status: "done", best_email: "office@ashdown-roofing.example", too_big: 0, researched_at: "2026-10-19T07:00:00Z", notes: "" },
    { place_id: "p2", status: "done", best_email: "info@fenwick-plumbing.example", too_big: 0, researched_at: "2026-10-20T07:00:00Z", notes: "" },
    { place_id: "p7", status: "done", best_email: null, too_big: 0, researched_at: "2026-10-21T07:00:00Z", notes: "" },
    { place_id: "p8", status: "skipped", best_email: null, too_big: 0, researched_at: "2026-10-21", notes: "" },
    { place_id: "p9", status: "done", best_email: "jo@wren-driving.example", too_big: 0, researched_at: "2026-10-12T07:00:00Z", notes: "[Nik 2026-10-22] wrong owner" },
    { place_id: "p10", status: "skipped", best_email: null, too_big: 0, researched_at: "2026-10-21", notes: "[Nik 2026-10-21] Not a fit: Wrong trade" },
  ],
  escalations: [
    { place_id: "p3", dedupe: "escalation:i4", created_at: "2026-10-21T07:05:00Z" },
  ],
});
