// POST /api/setup/mailboxes/<id>/test
//   {action:"login"}          → {ok, ms, error?}: log in to Namecheap and out again (Setup's Test login).
//   {action:"send", to}       → {ok, ms, error?}: send one plain test email (Setup's Send test email, the SMTP proof).
// The send goes straight through sendViaSmtp, not the outbox, on purpose: it isn't capped, windowed or held by a pause.
// It records a messages row (kind and author "system"; "sending", then "sent" or "failed", so a send Cloudflare cuts
// off mid-way (Error 1102) is still on record and the outbox's stuck-row sweep marks it failed), the setting
// smtp:proof = JSON {at, ok, ms, mailbox_id, error}, and setup:test_to = to (the address the form remembers).
// SMTP results are 200 with ok true or false; bad input is 400 with the same shape. No answer contains the password.
import { composeEmail, makeMessageId } from "../../../../_lib/mail/compose.js";
import { sendViaSmtp, testSmtpLogin } from "../../../../_lib/mail/smtp.js";
import { getSecret, setSetting } from "../../../../_lib/settings.js";
import { ukDate, ukParts } from "../../../../_lib/ukTime.js";
import { db, json } from "../../../../_lib/util.js";
import { ERRORS, emailOrNull, loadMailbox, readJson } from "../../mailboxes.js";

export const TEST_SUBJECT = "Aetos test email";
const NO_PASSWORD = "Save the mailbox password first.";
const ACTION_ERROR = "Action must be login or send.";

const fail = (error, status = 200) => json({ ok: false, ms: 0, error }, status);
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
const two = (n) => String(n).padStart(2, "0");

/** The test email's text: which mailbox sent it and when (UK time), so each of the 10 proof sends can be told apart. */
export function testEmailText(address, at) {
  const { hh, mm } = ukParts(at);
  return `This is a test from your Control Room, sent through ${address} at ${two(hh)}:${two(mm)} on ${ukDate(at)} (UK time).\n\n`
    + "If it's in your inbox (not spam), sending works.\n";
}

export async function onRequestPost({ request, env, params }) {
  const DB = await db(env);
  const body = await readJson(request);
  if (!body) return fail(ERRORS.json, 400);
  const mailbox = await loadMailbox(DB, params.id);
  if (!mailbox) return fail(ERRORS.notFound, 404);
  const opts = { mailer: env.__mailer }; // tests only; undefined live, so smtp.js loads worker-mailer

  if (body.action === "login") {
    const password = await getSecret(DB, `mailbox:${mailbox.id}`);
    if (!password) return fail(NO_PASSWORD);
    return json(await testSmtpLogin(mailbox, password, opts));
  }
  if (body.action !== "send") return fail(ACTION_ERROR, 400);

  const to = emailOrNull(body.to);
  if (!to) return fail(ERRORS.address, 400);
  await setSetting(DB, "setup:test_to", to);
  const password = await getSecret(DB, `mailbox:${mailbox.id}`);
  if (!password) return fail(NO_PASSWORD); // nothing tried, so nothing recorded

  const at = new Date();
  const from = { name: mailbox.display_name, address: mailbox.address };
  let message;
  try {
    const { headers, text } = composeEmail({
      from, to, subject: TEST_SUBJECT, body: testEmailText(mailbox.address, at), messageId: makeMessageId(mailbox.address), date: at,
    });
    message = { from, to, subject: TEST_SUBJECT, text, headers };
  } catch (err) {
    return fail(err.message, 400); // composeEmail's errors are plain English and never carry the password
  }

  const id = crypto.randomUUID();
  await DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, kind, author, to_addr, from_addr, subject, body, message_id, status, due_at, created_at)
     VALUES (?, ?, 'out', 'system', 'system', ?, ?, ?, ?, ?, 'sending', ?, ?)`,
  ).bind(id, mailbox.id, to, mailbox.address, TEST_SUBJECT, message.text, message.headers["Message-ID"], iso(at), iso(at)).run();

  const result = await sendViaSmtp(mailbox, password, message, opts);
  const error = result.ok ? null : result.error;
  await DB.prepare("UPDATE messages SET status = ?, sent_at = ?, error = ? WHERE id = ?")
    .bind(result.ok ? "sent" : "failed", result.ok ? iso(new Date()) : null, error, id)
    .run();
  await setSetting(DB, "smtp:proof", JSON.stringify({ at: iso(at), ok: result.ok, ms: result.ms, mailbox_id: mailbox.id, error }));
  return json(result);
}
