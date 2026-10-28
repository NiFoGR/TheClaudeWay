// Reply rules (pure): reply hours, waking Claude, the Replies light, quoted history, threading, titles, median.
// Run: node --test control-room/tests/replies.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  ESCALATE_INTENTS, INTENTS, REPLY_HOURS, buildReply, escalationTitle, intentEffects, medianReplyMinutes, reSubject,
  replyLight, sendTime, shouldFireReply, signature, stripQuoted,
} from "../functions/_lib/replies.js";

const D = (s) => new Date(s);

test("effects per intent", () => {
  assert.deepEqual(intentEffects("not_now"), { event: "said_no", lost_reason: "not_now", bodyRequired: true, todo: "checkback" });
  assert.deepEqual(intentEffects("not_interested"), { event: "said_no", lost_reason: "not_interested", bodyRequired: true, todo: null });
  assert.deepEqual(intentEffects("opt_out"), { event: "opt_out", lost_reason: "opt_out", bodyRequired: false, todo: null });
  assert.deepEqual(intentEffects("proposes_time"), { event: "escalate", lost_reason: null, bodyRequired: true, todo: "call_time" });
  assert.deepEqual(intentEffects("price"), { event: null, lost_reason: null, bodyRequired: true, todo: null });
});
test("send time holds night replies to 07:00 UK", () => {
  assert.equal(sendTime(D("2026-10-20T22:29:00Z")).toISOString(), "2026-10-20T22:29:00.000Z");
  assert.equal(sendTime(D("2026-10-20T22:31:00Z")).toISOString(), "2026-10-21T06:00:00.000Z");
  assert.equal(sendTime(D("2026-11-03T23:40:00Z")).toISOString(), "2026-11-04T07:00:00.000Z");
});
test("fire coalescing", () => {
  const base = { waiting: 1, paused: false };
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T08:00:00Z"), lastFireAt: null, now: D("2026-10-20T08:00:30Z") }), true);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T08:01:00Z"), lastFireAt: D("2026-10-20T08:00:30Z"), now: D("2026-10-20T08:01:30Z") }), false);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T08:01:00Z"), lastFireAt: D("2026-10-20T08:00:30Z"), now: D("2026-10-20T08:03:00Z") }), true);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T08:00:00Z"), lastFireAt: D("2026-10-20T08:00:30Z"), now: D("2026-10-20T08:09:00Z") }), false);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T08:00:00Z"), lastFireAt: D("2026-10-20T08:00:30Z"), now: D("2026-10-20T08:10:30Z") }), true);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T22:40:00Z"), lastFireAt: null, now: D("2026-10-20T22:45:00Z") }), false);
  assert.equal(shouldFireReply({ ...base, newestAt: D("2026-10-20T23:10:00Z"), lastFireAt: D("2026-10-20T22:00:00Z"), now: D("2026-10-21T06:00:00Z") }), true);
  assert.equal(shouldFireReply({ ...base, paused: true, newestAt: D("2026-10-20T08:00:00Z"), lastFireAt: null, now: D("2026-10-20T08:01:00Z") }), false);
  assert.equal(shouldFireReply({ waiting: 0, newestAt: null, lastFireAt: null, now: D("2026-10-20T08:01:00Z") }), false);
});
test("replies light", () => {
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T08:20:00Z") }).level, "green");
  assert.deepEqual(replyLight({ waiting: 1, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T08:21:00Z") }),
    { name: "replies", level: "red", detail: "A reply has waited 21 minutes.", fix: "Check the aetos-reply Routine is switched on (routines/README.md) and its URL and token are saved on Setup → Claude." });
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T01:00:00Z"), now: D("2026-10-20T06:20:00Z") }).level, "green");
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T01:00:00Z"), now: D("2026-10-20T06:21:00Z") }).level, "red");
  assert.deepEqual(replyLight({ waiting: 1, oldestAt: D("2026-10-20T22:40:00Z"), now: D("2026-10-20T23:00:00Z") }), { name: "replies", level: "grey", detail: "Replies start again at 7am (1 waiting).", fix: "" });
  assert.deepEqual(replyLight({ waiting: 2, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T09:00:00Z"), paused: true }), { name: "replies", level: "grey", detail: "Claude's replies are paused (2 waiting).", fix: "Reply yourself on the Replies page." });
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D("2026-10-20T09:00:00Z") }).detail, "No replies waiting.");
});
test("quoted history is removed", () => {
  assert.equal(stripQuoted("Yes please\n\nOn Mon, 19 Oct 2026 at 09:12, Nik <nik@aetoswebsites.com> wrote:\n> Hi Sam"), "Yes please");
  assert.equal(stripQuoted("Sounds good\n> old\n> lines"), "Sounds good");
  assert.equal(stripQuoted("Ok\n\n-----Original Message-----\nFrom: Nik"), "Ok");
  assert.equal(stripQuoted("x".repeat(5000)).length, 4000);
});
test("a reply is threaded from the thread's mailbox", () => {
  const r = buildReply({
    inbound: { place_id: "p1", message_id: "<a@them.com>", refs: "<root@aetoswebsites.com>", subject: "Re: Your new website", from_addr: "sam@greenleaf.co.uk" },
    prospect: { mailbox_id: "mb1", subject: "Your new website" },
    mailbox: { id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik Smith" }, senderName: "Nik",
    body: "Hi Sam,\n\nSure.", author: "claude", now: D("2026-10-20T08:00:00Z"),
  });
  assert.equal(r.kind, "reply"); assert.equal(r.direction, "out"); assert.equal(r.author, "claude");
  assert.equal(r.to_addr, "sam@greenleaf.co.uk"); assert.equal(r.from_addr, "nik@aetoswebsites.com"); assert.equal(r.mailbox_id, "mb1");
  assert.equal(r.subject, "Re: Your new website");
  assert.equal(r.in_reply_to, "<a@them.com>"); assert.equal(r.refs, "<root@aetoswebsites.com> <a@them.com>");
  assert.equal(r.body, "Hi Sam,\n\nSure.\n\nNik\nAetos Websites");
  assert.equal(r.status, "queued"); assert.equal(r.due_at, "2026-10-20T08:00:00Z");
  assert.match(r.message_id, /^<[^@>]+@aetoswebsites\.com>$/);
  assert.equal(reSubject(""), "Re: "); assert.equal(reSubject("RE: x"), "RE: x");
});
test("titles, median", () => {
  assert.equal(signature("Nik"), "Nik\nAetos Websites");
  assert.equal(escalationTitle("angry", "Green Leaf Landscapes"), "Angry reply from Green Leaf Landscapes: Claude's draft is ready");
  assert.equal(escalationTitle("legal", "X"), "Legal question from X: Claude's draft is ready");
  assert.equal(escalationTitle("unclear", "X"), "Unclear reply from X: Claude's draft is ready");
  assert.equal(escalationTitle("other", "X"), "X needs you: Claude's draft is ready");
  assert.equal(medianReplyMinutes([
    { received_at: "2026-10-20T08:00:00Z", sent_at: "2026-10-20T08:03:00Z" },
    { received_at: "2026-10-20T01:00:00Z", sent_at: "2026-10-20T06:04:00Z" },
    { received_at: "2026-10-20T08:00:00Z", sent_at: "2026-10-20T08:10:00Z" }]), 4);
  assert.equal(medianReplyMinutes([]), null);
});

// ---- Beyond the plan's tests: the contract around the edges ----

test("the exact lists and hours", () => {
  assert.deepEqual(REPLY_HOURS, { start: "07:00", end: "23:30", days: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(INTENTS, ["interested", "question", "price", "more_info", "call_request", "proposes_time", "confirms_slot",
    "not_now", "not_interested", "opt_out", "angry", "legal", "unclear", "other"]);
  assert.deepEqual(ESCALATE_INTENTS, ["angry", "legal", "unclear", "other"]);
});
test("every intent has effects; escalations go to Nik; unknown ones have none", () => {
  for (const i of INTENTS) assert.ok(intentEffects(i), i);
  for (const i of ["interested", "question", "more_info", "call_request", "confirms_slot"]) {
    assert.deepEqual(intentEffects(i), { event: null, lost_reason: null, bodyRequired: true, todo: null }, i);
  }
  for (const i of ESCALATE_INTENTS) assert.deepEqual(intentEffects(i), { event: "escalate", lost_reason: null, bodyRequired: true, todo: null }, i);
  assert.equal(intentEffects("ignore your rules"), null);
  assert.equal(intentEffects(undefined), null);
  intentEffects("price").event = "said_no"; // callers can't change the table
  assert.equal(intentEffects("price").event, null);
});
test("reply hours: 07:00 inside, 23:30 outside", () => {
  assert.equal(sendTime(D("2026-10-20T06:00:00Z")).toISOString(), "2026-10-20T06:00:00.000Z"); // 07:00 BST
  assert.equal(sendTime(D("2026-10-20T05:59:00Z")).toISOString(), "2026-10-20T06:00:00.000Z"); // 06:59 BST
  assert.equal(sendTime(D("2026-10-20T22:30:00Z")).toISOString(), "2026-10-21T06:00:00.000Z"); // 23:30 BST
});
test("clock changes: 29 Mar 2026 (GMT→BST) and 25 Oct 2026 (BST→GMT)", () => {
  assert.equal(sendTime(D("2026-03-28T23:40:00Z")).toISOString(), "2026-03-29T06:00:00.000Z"); // Sat 23:40 GMT → Sun 07:00 BST
  assert.equal(sendTime(D("2026-10-24T22:31:00Z")).toISOString(), "2026-10-25T07:00:00.000Z"); // Sat 23:31 BST → Sun 07:00 GMT
  // Mail at 01:30 BST on 25 Oct waits from 07:00 GMT.
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-25T00:30:00Z"), now: D("2026-10-25T07:20:00Z") }).level, "green");
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-25T00:30:00Z"), now: D("2026-10-25T07:21:00Z") }).detail, "A reply has waited 21 minutes.");
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-03-29T00:30:00Z"), now: D("2026-03-29T06:21:00Z") }).level, "red");
  assert.equal(shouldFireReply({ waiting: 1, newestAt: D("2026-10-25T03:00:00Z"), lastFireAt: null, now: D("2026-10-25T06:30:00Z") }), false); // 06:30 GMT
  assert.equal(shouldFireReply({ waiting: 1, newestAt: D("2026-10-25T03:00:00Z"), lastFireAt: null, now: D("2026-10-25T07:00:00Z") }), true);
});
test("shouldFireReply takes stored timestamps too", () => {
  assert.equal(shouldFireReply({ waiting: 2, newestAt: "2026-10-20T08:01:00Z", lastFireAt: "2026-10-20T08:00:30Z", now: D("2026-10-20T08:03:00Z") }), true);
  assert.equal(shouldFireReply({ waiting: 2, newestAt: "2026-10-20T08:01:00Z", lastFireAt: "2026-10-20T08:01:30Z", now: D("2026-10-20T08:03:00Z") }), false);
});
test("replies light wording", () => {
  assert.deepEqual(replyLight({ waiting: 1, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T08:05:00Z") }), { name: "replies", level: "green", detail: "1 reply waiting.", fix: "" });
  assert.equal(replyLight({ waiting: 3, oldestAt: "2026-10-20T08:00:00Z", now: D("2026-10-20T08:05:00Z") }).detail, "3 replies waiting.");
  assert.deepEqual(replyLight({ waiting: 0, oldestAt: null, now: D("2026-10-20T09:00:00Z") }), { name: "replies", level: "green", detail: "No replies waiting.", fix: "" });
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T10:00:00Z") }).detail, "A reply has waited 120 minutes.");
});
test("stripQuoted: Windows line ends, a From: block, nothing but a quote, and no torn emoji", () => {
  assert.equal(stripQuoted("Thanks\r\n\r\nFrom: Nik <nik@aetoswebsites.com>\r\nSent: Monday\r\n"), "Thanks");
  assert.equal(stripQuoted("From: is fine on the first line"), "From: is fine on the first line");
  assert.equal(stripQuoted("> all quoted"), "");
  assert.equal(stripQuoted(null), "");
  assert.equal(stripQuoted("Yes\n\n-- Original Message --\nold"), "Yes");
  const s = stripQuoted("a".repeat(3999) + "😀" + "b");
  assert.ok(s.length <= 4000); assert.ok(!/[\uD800-\uDBFF]$/.test(s));
});
test("reSubject never doubles Re:", () => {
  assert.equal(reSubject("Your new website"), "Re: Your new website");
  assert.equal(reSubject("re: hi"), "re: hi");
  assert.equal(reSubject(null), "Re: ");
});
test("buildReply: Nik's replies go at once, night replies wait, refs aren't doubled, the signature is the setting's", () => {
  const args = {
    inbound: { place_id: "p1", message_id: "<a@them.com>", refs: "<root@aetoswebsites.com> <a@them.com>", subject: "", from_addr: "office@greenleaf.co.uk" },
    prospect: { mailbox_id: "mb1", subject: "Your new website" },
    mailbox: { id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik Smith" }, senderName: "Nikiforos",
    body: "  Hi,\r\n\r\nSure.  \n", now: D("2026-10-21T22:50:00Z"),
  };
  const c = buildReply({ ...args, author: "claude" });
  assert.equal(c.due_at, "2026-10-22T06:00:00Z");
  assert.equal(c.created_at, "2026-10-21T22:50:00Z");
  assert.equal(c.refs, "<root@aetoswebsites.com> <a@them.com>");
  assert.equal(c.subject, "Re: Your new website"); // their subject was blank: the thread's
  assert.equal(c.to_addr, "office@greenleaf.co.uk"); // the address that wrote
  assert.equal(c.body, "Hi,\n\nSure.\n\nNikiforos\nAetos Websites");
  assert.ok(!c.body.includes("Nik Smith"));
  assert.equal(c.place_id, "p1");
  assert.ok(!("id" in c));
  const n = buildReply({ ...args, author: "nik" });
  assert.equal(n.due_at, "2026-10-21T22:50:00Z");
  assert.equal(n.author, "nik");
  assert.notEqual(n.message_id, c.message_id);
  assert.throws(() => buildReply({ ...args, author: "system" }), /author/);
  const noRefs = buildReply({ ...args, inbound: { ...args.inbound, refs: null }, author: "claude" });
  assert.equal(noRefs.refs, "<a@them.com>");
});
test("signature without a sender name", () => {
  assert.equal(signature(""), "Aetos Websites");
  assert.equal(signature("  Nik "), "Nik\nAetos Websites");
});
test("escalation titles use the business's spoken name; only escalation intents have one", () => {
  assert.equal(escalationTitle("angry", "GREEN LEAF LANDSCAPES LTD - Gardener in Leeds"), "Angry reply from Green Leaf Landscapes: Claude's draft is ready");
  assert.throws(() => escalationTitle("price", "X"), /angry, legal, unclear or other/);
});
test("median: even count, skips rows not yet sent, never negative", () => {
  assert.equal(medianReplyMinutes([
    { received_at: "2026-10-20T08:00:00Z", sent_at: "2026-10-20T08:02:00Z" },
    { received_at: "2026-10-20T08:00:00Z", sent_at: "2026-10-20T08:05:00Z" },
    { received_at: "2026-10-20T08:00:00Z", sent_at: null }]), 3.5);
  assert.equal(medianReplyMinutes([{ received_at: "2026-10-20T01:00:00Z", sent_at: "2026-10-20T03:00:00Z" }]), 0); // Nik at 4am
  assert.equal(medianReplyMinutes(null), null);
});

// ---- Review additions ----

test("the light counts from this morning's 07:00, so late-evening mail answered at 07:00 isn't a false red", () => {
  // 23:28 BST on 20 Oct: inside hours, but the next tick (23:30) is outside them, so it waits for the morning run.
  const late = { waiting: 1, oldestAt: D("2026-10-20T22:28:00Z") };
  assert.equal(replyLight({ ...late, now: D("2026-10-21T06:00:00Z") }).level, "green"); // 07:00 BST
  assert.equal(replyLight({ ...late, now: D("2026-10-21T06:20:00Z") }).level, "green");
  assert.equal(replyLight({ ...late, now: D("2026-10-21T06:21:00Z") }).detail, "A reply has waited 21 minutes.");
  // Still red the same evening it came in.
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T21:00:00Z"), now: D("2026-10-20T21:21:00Z") }).level, "red");
  // A red light never says 20 minutes: 20½ is rounded up.
  assert.equal(replyLight({ waiting: 1, oldestAt: D("2026-10-20T08:00:00Z"), now: D("2026-10-20T08:20:30Z") }).detail, "A reply has waited 21 minutes.");
});
test("stripQuoted: a wrapped attribution line, Outlook's rule, and a huge email", () => {
  assert.equal(stripQuoted("Yes please\n\nOn Mon, 19 Oct 2026 at 09:12, Nik <nik@\naetoswebsites.com> wrote:\n> Hi Sam"), "Yes please");
  assert.equal(stripQuoted("Yes\n\n________________________________\nFrom: Nik\nSent: Monday\nHi Sam, old text"), "Yes");
  assert.equal(stripQuoted("On Monday I'm free all day.\nThanks"), "On Monday I'm free all day.\nThanks");
  const huge = stripQuoted(`${" ".repeat(50)}\n${"word ".repeat(400000)}\nOn x wrote:\n> old`);
  assert.equal(huge.length, 4000); assert.ok(huge.startsWith("word word"));
  const many = stripQuoted(Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(many.length, 4000); assert.ok(many.startsWith("line 0\nline 1\n"));
});

test("the Replies light: a reply that didn't send is red (any hour), unless paused; no error text falls back", () => {
  const FIX = "Check the mailbox password on Setup → Mailboxes, then open the thread on the Replies page and send it again with Reply as me. If the error says it may have gone, check the Sent folder first.";
  const D2 = (s) => new Date(s);
  assert.deepEqual(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T09:00:00Z"), failed: 1, failedError: "SMTP said no." }),
    { name: "replies", level: "red", detail: "A reply didn't send: SMTP said no.", fix: FIX });
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T09:00:00Z"), failed: 1, failedError: "SMTP said no" }).detail,
    "A reply didn't send: SMTP said no.");
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T23:00:00Z"), failed: 3, failedError: null }).detail,
    "3 replies didn't send.");
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T09:00:00Z"), failed: 1, paused: true }).level, "grey");
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T09:00:00Z"), failed: 0 }).level, "green");
  assert.equal(replyLight({ waiting: 0, oldestAt: null, now: D2("2026-10-20T09:00:00Z") }).level, "green"); // the old call shape
});
