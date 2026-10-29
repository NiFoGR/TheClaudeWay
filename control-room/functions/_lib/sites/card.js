// The printable Google review card, /s/review-card on the client's own host (pure, stage 10: docs/rebuild/09-build.md
// section 12, exact copy). One A4 sheet of 8 business cards (85 × 55 mm, 2 across, 4 down), each with the business
// name, "How did we do?", one line asking for a review, the QR code and the phone number. Below the sheet, on screen
// only, the three ready-made review requests with Copy buttons. A Print button that doesn't print.
//
// The QR encodes the review URL itself (Google's link, not ours), so the cards keep working forever. Nothing on the
// cards gates ("were you happy?") or offers anything for a review. The page is the client's: no Aetos name, noindex,
// no external files, one small inline script (the client-host CSP allows 'self' and inline only).
// Business name and phone come from the onboarding form: escaped with h() everywhere they appear.

import { cleanText, h } from "../demo/text.js";
import { checkReviewLink, reviewMessages } from "./copy.js";
import { qrSvg } from "./qr.js";

const NAME_MAX = 120;
const PHONE_MAX = 40;
const CARDS = 8;

const ASK = "We'd really appreciate a Google review. Scan the code with your phone camera.";
const NO_LINK = "There's no Google review link for this business yet.";
// qrSvg's own message ("That link is too long to fit in a QR code.") plus what to do: a page, never a 500.
const TOO_LONG = "This Google review link is too long to fit in a QR code. Send us the short link from your Google Business Profile (Ask for reviews) and we'll put that on your cards.";

const CSS = `@page { size: A4; margin: 0 }
*, *::before, *::after { box-sizing: border-box }
html, body { margin: 0; background: #fff; color: #111; font-family: Arial, Helvetica, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact }
.sheet { width: 210mm; margin: 0 auto; padding: 38mm 20mm; display: grid; grid-template-columns: 85mm 85mm;
  grid-auto-rows: 55mm; align-content: start; background: #fff }
.card { width: 85mm; height: 55mm; padding: 4mm; border: 0.2mm dashed #bbb; display: flex; gap: 3mm;
  align-items: center; overflow: hidden; break-inside: avoid; page-break-inside: avoid }
.words { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: space-between }
.biz { margin: 0; font-size: 9.5pt; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; display: -webkit-box;
  -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden }
.ask-title { margin: 1mm 0 0; font-size: 14pt; font-weight: 700; line-height: 1.1 }
.ask { margin: 1.5mm 0 0; font-size: 7.5pt; line-height: 1.3 }
.phone { margin: 0; font-size: 10pt; font-weight: 700; white-space: nowrap }
.qr { flex: none; width: 37mm; height: 37mm }
.qr svg { display: block; width: 100%; height: 100% }
.print-btn { position: fixed; top: 12px; right: 12px; font: inherit; font-size: 16px; padding: 10px 18px;
  border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer }
.screen-only { max-width: 210mm; margin: 0 auto; padding: 24px 16px 48px; font-size: 16px; line-height: 1.5 }
.screen-only h2 { font-size: 20px; margin: 0 0 4px }
.screen-only h3 { font-size: 16px; margin: 24px 0 6px }
.screen-only textarea, .screen-only input { display: block; width: 100%; font: inherit; font-size: 15px; padding: 8px;
  border: 1px solid #999; border-radius: 6px; background: #fff; color: #111 }
.screen-only textarea { resize: vertical }
.screen-only input { margin-bottom: 6px }
.screen-only button { margin-top: 6px; font: inherit; padding: 6px 16px; border: 1px solid #111; border-radius: 6px;
  background: #fff; color: #111; cursor: pointer }
.empty { max-width: 40em; margin: 0 auto; padding: 48px 16px; font-size: 18px; line-height: 1.5 }
@media screen { body { background: #e9e9e9 } .sheet { margin: 64px auto 0; box-shadow: 0 1px 6px rgba(0,0,0,.25);
  max-width: 100%; overflow-x: auto } }
@media print { .screen-only, .print-btn { display: none } }
@media print { body { background: #fff } .sheet { margin: 0; box-shadow: none } }`;

const SCRIPT = `(function () {
  var p = document.querySelector(".print-btn");
  if (p) p.addEventListener("click", function () { window.print(); });
  var buttons = document.querySelectorAll("[data-copy]");
  for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", copy);
  function copy(e) {
    var b = e.currentTarget, t = document.getElementById(b.getAttribute("data-copy"));
    if (!t) return;
    function done() { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 2000); }
    function fallback() { t.focus(); t.select(); try { document.execCommand("copy"); done(); } catch (err) {} }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(done, fallback);
    else fallback();
  }
})();`;

function page(title, body) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function card(name, phone, svg) {
  return `<div class="card"><div class="words"><div>` +
    `<p class="biz">${h(name)}</p>` +
    `<p class="ask-title">How did we do?</p>` +
    `<p class="ask">${h(ASK)}</p></div>` +
    (phone ? `<p class="phone">${h(phone)}</p>` : "") +
    `</div><div class="qr">${svg}</div></div><!-- /card -->`;
}

function template(id, title, text, rows) {
  return `<h3>${h(title)}</h3>` +
    `<textarea id="${id}" rows="${rows}" readonly>${h(text)}</textarea>` +
    `<button type="button" data-copy="${id}">Copy</button>`;
}

/**
 * The review card page for `{business, phone, owner, reviewUrl}`: owner is the owner's first name when confident
 * (blank signs the templates with the business name). A review URL that isn't a Google review link (or none) gives a
 * plain noindex page saying there's no link yet, never a QR code to somewhere else.
 */
export function renderReviewCard({ business, phone, owner, reviewUrl } = {}) {
  const name = cleanText(business, NAME_MAX);
  const tel = cleanText(phone, PHONE_MAX);
  const title = name ? `Google review cards: ${name}` : "Google review cards";
  const checked = checkReviewLink(reviewUrl);
  if (!checked.ok) return page(title, `<main class="empty"><p>${h(NO_LINK)}</p></main>`);

  const link = checked.url;
  let svg;
  try {
    svg = qrSvg(link);
  } catch {
    return page(title, `<main class="empty"><p>${h(TOO_LONG)}</p></main>`);
  }
  const cards = Array.from({ length: CARDS }, () => card(name, tel, svg)).join("\n");
  const m = reviewMessages({ business: name, owner, link });

  const screen = `<section class="screen-only">
<h2>Ask every customer the same way</h2>
<p>Send the first message the day you finish a job, and the reminder 3 to 5 days later. Put your customer's name where it says {customer}.</p>
${template("msg-sms", "Text or WhatsApp, the day the job finishes", m.sms, 4)}
<h3>Email, the day the job finishes</h3>
<input id="msg-email-subject" type="text" readonly aria-label="Subject" value="${h(m.email.subject)}">
<textarea id="msg-email" rows="10" readonly aria-label="Email">${h(m.email.body)}</textarea>
<button type="button" data-copy="msg-email">Copy</button>
${template("msg-reminder", "Reminder, 3 to 5 days later (text or email)", m.reminder, 4)}
</section>`;

  return page(title, `<button type="button" class="print-btn">Print</button>
<main class="sheet">
${cards}
</main>
${screen}
<script>${SCRIPT}</script>`);
}
