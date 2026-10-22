// SMTP sending through Namecheap Private Email, with the vendored worker-mailer over cloudflare:sockets.
// The library is imported lazily (only when no `mailer` is passed), so Node tests never load cloudflare:sockets.
// Nothing here throws: every failure comes back as {ok:false, ms, error} with the error in plain English.
// The password never appears in a result, and worker-mailer is left at its default log level (INFO), because its
// DEBUG level logs the AUTH lines, which carry the password in base64.
// Bounces: with no DSN option, worker-mailer writes "RCPT TO:<…> NOTIFY=NEVER" whenever the server offers DSN (Postfix
// servers such as Namecheap's normally do), which tells the server never to send a bounce. Bounces are how a dead
// address gets suppressed and a mailbox paused, so every email asks for one on failure (NOTIFY=FAILURE). A server
// without DSN gets no NOTIFY at all.

const DEFAULT_HOST = "mail.privateemail.com";
const DEFAULT_PORT = 465;
const TIMEOUT_MS = 10000;
const MAX_SAID = 200; // characters of the server's reply quoted back

const LINE_BREAK = /[\r\n]/;
const PLAIN_ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;
const ASCII = /^[\x21-\x7e]+$/;
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/; // printable ASCII, no colon
const TIMED_OUT = /time\s?out|timed\s?out/i;
const NO_LINK = /connection (?:closed|lost|refused|reset)|closed by server|network|socket|econn|enotfound|getaddrinfo|unreachable|(?:can't|cannot|could not|failed to) connect|proxy request failed|stream was cancelled|broken pipe|shutting down/i;
const WRONG_PASSWORD_WORDS = /authentication failed|invalid credentials|bad credentials|password is wrong|wrong password/i;

// String(x) that never throws (an object whose toString throws gives "").
function asString(value) {
  try {
    return value == null ? "" : String(value);
  } catch {
    return "";
  }
}

function server(mailbox) {
  const m = mailbox && typeof mailbox === "object" ? mailbox : {};
  const field = (name) => {
    try {
      return asString(m[name]).trim();
    } catch {
      return ""; // a getter that throws
    }
  };
  const host = field("smtp_host") || DEFAULT_HOST;
  const portNumber = Number(field("smtp_port"));
  const port = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536 ? portNumber : DEFAULT_PORT;
  return { host, port, address: field("address") };
}

function options(mailbox, password) {
  const { host, port, address } = server(mailbox);
  return {
    host,
    port,
    secure: true,
    authType: "login",
    credentials: { username: address, password: asString(password) },
    socketTimeoutMs: TIMEOUT_MS,
    responseTimeoutMs: TIMEOUT_MS,
  };
}

function errorText(err) {
  try {
    if (err == null) return "";
    if (typeof err === "string") return err;
    if (typeof err === "object") return typeof err.message === "string" ? err.message : "";
    return String(err);
  } catch {
    return "";
  }
}

const tidy = (s) => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
const cut = (s) => (s.length > MAX_SAID ? `${s.slice(0, MAX_SAID - 1)}…` : s);

// The server's reply inside a worker-mailer error, e.g. "Failed send email body: 554 5.7.1 Rejected" → its code and
// words. Angle-bracketed addresses are skipped when looking for the code, so "<bob@123.com>" isn't read as one.
function reply(raw) {
  const text = tidy(raw);
  const masked = text.replace(/<[^>]*>/g, (m) => " ".repeat(m.length));
  // "port 465" in a socket error is a port, not a reply code.
  const found = /(?:^|\s)(?<!port\s)([45]\d\d)(?=[\s-]|$)/i.exec(masked);
  if (!found) return { code: null, said: cut(text) };
  const at = found.index + found[0].indexOf(found[1]);
  return { code: Number(found[1]), said: cut(text.slice(at)) };
}

const passwordWrong = (address) =>
  `Namecheap said the password is wrong for ${address || "this mailbox"}. Copy it again from Namecheap → Private Email, paste it here, press Save, then Test login.`;

/**
 * The start of every error that means the email may already have gone (the line dropped or went silent after the
 * login, a send that threw, a row stuck in `sending`). Stage 6 never retries a failed follow-up whose error starts
 * with it, and retries any other failure, so no definite failure (a refusal, a login problem) may start with it.
 * outbox.js re-exports it; it lives here, the lower module, so there's no import cycle.
 */
export const INTERRUPTED_PREFIX = "The send was interrupted";
/** What every such error ends with. */
export const MAYBE_SENT = "It may or may not have gone: check the Sent folder in Namecheap webmail before sending again.";

/**
 * A plain-English explanation of a worker-mailer (or socket) error, for Nik. Pure. `stage` is "connect" (connecting
 * and logging in, the default) or "send" (after login), because a dropped line while sending may still have
 * delivered the email.
 */
export function explainSmtpError(err, mailbox, stage = "connect") {
  const { host, port, address } = server(mailbox);
  const raw = errorText(err);
  const { code, said } = reply(raw);
  const words = said || "no reason given";
  const enhanced = /(?:^|\s)([245])\.\d{1,3}\.\d{1,3}(?=\s|$)/.exec(tidy(raw).replace(/<[^>]*>/g, " "));
  const temporary = code ? code < 500 : enhanced?.[1] === "4";

  if (code === 535 || enhanced?.[0].trim() === "5.7.8" || (!code && !temporary && WRONG_PASSWORD_WORDS.test(raw))) {
    return passwordWrong(address);
  }

  if (stage === "send") {
    if (/At least one of text or html/i.test(raw)) return "The email is empty: write the message, then send it again.";
    if (code && temporary) {
      return `Namecheap couldn't take this email right now (it said: "${words}"). It wasn't sent. Try again later.`;
    }
    if (code && /RCPT TO/i.test(raw)) {
      const to = /RCPT TO:\s*<([^<>]*)>/i.exec(raw)?.[1] ?? "";
      return `Namecheap refused the address ${to || "it was sent to"} (it said: "${words}"). It wasn't sent. Check the address is right.`;
    }
    if (code) return `Namecheap refused this email (it said: "${words}"). It wasn't sent. Fix what it says, then send it again.`;
    // Ambiguous: Namecheap may already have queued it. Both start with INTERRUPTED_PREFIX (see above).
    if (TIMED_OUT.test(raw)) {
      return `${INTERRUPTED_PREFIX}: ${host} stopped answering while the email was being sent (nothing back within ${TIMEOUT_MS / 1000} seconds). ${MAYBE_SENT}`;
    }
    return `${INTERRUPTED_PREFIX}: the connection to ${host} broke while the email was being sent (${words}). ${MAYBE_SENT}`;
  }

  if (code && temporary) {
    return `${host} turned the login away for now (it said: "${words}"). Wait a few minutes, then try again.`;
  }
  if (code) {
    return `${host} refused the login (it said: "${words}"). Check the address and password on Setup → Mailboxes, then press Test login.`;
  }
  if (TIMED_OUT.test(raw) || NO_LINK.test(raw)) {
    return `Couldn't connect to ${host} on port ${port} within ${TIMEOUT_MS / 1000} seconds. Wait a minute and try again. If it keeps failing, Namecheap's mail server may be down.`;
  }
  const sentence = words.replace(/[\s.:;,!]+$/, "") || "no reason given";
  return `Couldn't log in to ${host}: ${sentence}. Try again in a minute; if the same error comes back, ask Claude to look at it.`;
}

function base64(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Belt and braces: if a server or library ever echoes the password (or its base64), it's hidden. Applied to the raw
// error before it's shortened (so a cut can't leave part of it) and to the final text.
function scrub(text, password) {
  const pw = asString(password);
  if (pw.length < 4) return text;
  let out = text.split(pw).join("[hidden]");
  try {
    out = out.split(base64(pw)).join("[hidden]");
  } catch {
    // btoa can't fail on bytes; nothing to hide
  }
  return out;
}

function mailboxProblem(mailbox, password) {
  if (password == null || password === "") return "Save the mailbox password first.";
  if (!mailbox || typeof mailbox !== "object") return "There's no mailbox to send from: add one on Setup → Mailboxes.";
  const { address } = server(mailbox);
  if (!PLAIN_ADDRESS.test(address) || !ASCII.test(address)) {
    return "This mailbox's address isn't a plain email address. Check it on Setup → Mailboxes.";
  }
  return null;
}

// What worker-mailer will write to the wire: every value is checked here too, not only in composeEmail, because a
// line break in a header (or in an address in the SMTP envelope) would let scraped text inject commands.
function emailFor(mailbox, message) {
  if (!message || typeof message !== "object") return { problem: "There's no message to send." };
  const fromAddress = asString(message.from?.address ?? server(mailbox).address).trim();
  const fromName = message.from ? message.from.name : mailbox.display_name;
  const to = asString(message.to).trim();
  if (message.headers != null && (typeof message.headers !== "object" || Array.isArray(message.headers))) {
    return { problem: "The email's headers aren't in the right shape, so it wasn't sent." };
  }
  // Copied, because worker-mailer adds its own headers to the object it's given. An empty (null/undefined) value is
  // left out: worker-mailer would write it as the word "undefined".
  const headers = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (value == null) continue;
    if (!HEADER_NAME.test(name)) return { problem: "One of the email's header names isn't valid, so it wasn't sent." };
    const checked = asString(value); // the exact text that was checked is the text that's sent
    if (LINE_BREAK.test(checked)) return { problem: "Header values can't contain line breaks" };
    headers[name] = checked;
  }
  for (const v of [fromName, message.subject]) {
    if (v != null && LINE_BREAK.test(asString(v))) return { problem: "Header values can't contain line breaks" };
  }
  if (!PLAIN_ADDRESS.test(to) || !ASCII.test(to)) {
    return { problem: "The To address isn't a plain email address (like name@example.com). Check it and try again." };
  }
  if (!PLAIN_ADDRESS.test(fromAddress) || !ASCII.test(fromAddress)) {
    return { problem: "The From address isn't a plain email address. Check this mailbox's address on Setup → Mailboxes." };
  }
  const text = asString(message.text);
  if (!text) return { problem: "The email is empty: write the message, then send it again." };
  const name = asString(fromName).trim();
  return {
    email: {
      from: name ? { name, email: fromAddress } : { email: fromAddress },
      to: { email: to },
      subject: asString(message.subject),
      text,
      headers,
      dsnOverride: { NOTIFY: { FAILURE: true } }, // a bounce comes back when delivery fails (see the top)
    },
  };
}

async function loadMailer(mailer) {
  if (mailer) return { Mailer: mailer };
  try {
    return { Mailer: (await import("./vendor/worker-mailer.js")).WorkerMailer };
  } catch (err) {
    return {
      problem: `The email library didn't load (${cut(tidy(errorText(err))) || "no reason given"}). Sending only works on Cloudflare; if this is the live site, redeploy it.`,
    };
  }
}

async function closeQuietly(conn) {
  if (!conn) return;
  try {
    await conn.close();
  } catch {
    // the email (or the login) already succeeded or failed; a failed QUIT changes nothing
  }
}

/**
 * Send one message: connect and log in, send, close. Never throws.
 * `message` = {from:{name,address}, to, subject, text, headers} (headers from composeEmail, used as they are).
 */
export async function sendViaSmtp(mailbox, password, message, opts = {}) {
  try {
    return await send(mailbox, password, message, opts);
  } catch (err) {
    // Only odd input gets here, before anything is sent (connecting and sending have their own catch below).
    return unexpected(err, password, "The email wasn't sent");
  }
}

/** Log in and log out again, sending nothing (Setup's Test login). Never throws. */
export async function testSmtpLogin(mailbox, password, opts = {}) {
  try {
    return await login(mailbox, password, opts);
  } catch (err) {
    return unexpected(err, password, "The login wasn't tried");
  }
}

function unexpected(err, password, outcome) {
  const why = cut(tidy(scrub(errorText(err), password))) || "no reason given";
  return { ok: false, ms: 0, error: `${outcome}: something unexpected went wrong (${why}). Ask Claude to look at it.` };
}

async function send(mailbox, password, message, opts) {
  const refused = mailboxProblem(mailbox, password);
  if (refused) return { ok: false, ms: 0, error: refused };
  const { email, problem } = emailFor(mailbox, message);
  if (problem) return { ok: false, ms: 0, error: problem };

  const started = Date.now();
  let conn = null;
  let error = null;
  let stage = "connect";
  try {
    const loaded = await loadMailer(opts?.mailer);
    if (loaded.problem) {
      error = loaded.problem;
    } else {
      conn = await loaded.Mailer.connect(options(mailbox, password));
      stage = "send";
      await conn.send(email);
    }
  } catch (err) {
    error = explainSmtpError(scrub(errorText(err), password), mailbox, stage);
  } finally {
    await closeQuietly(conn);
  }
  const ms = Math.max(0, Date.now() - started);
  return error ? { ok: false, ms, error: scrub(error, password) } : { ok: true, ms };
}

async function login(mailbox, password, opts) {
  const refused = mailboxProblem(mailbox, password);
  if (refused) return { ok: false, ms: 0, error: refused };

  const started = Date.now();
  let conn = null;
  let error = null;
  try {
    const loaded = await loadMailer(opts?.mailer);
    if (loaded.problem) error = loaded.problem;
    else conn = await loaded.Mailer.connect(options(mailbox, password));
  } catch (err) {
    error = explainSmtpError(scrub(errorText(err), password), mailbox, "connect");
  } finally {
    await closeQuietly(conn);
  }
  const ms = Math.max(0, Date.now() - started);
  return error ? { ok: false, ms, error: scrub(error, password) } : { ok: true, ms };
}
