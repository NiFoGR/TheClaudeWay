// The enquiry email to the business for one site_leads row (stage 10, docs/rebuild/09-build.md sections 9 and 12):
// the contact form calls it at once, tick step `sites` calls it for a chat lead once the chat has gone quiet.
//
// It goes through stage 9's sendClientMail (system mailbox first, kind `system`, author `system`, client_id set) to the
// form's business.leads_email, with enquiryEmail's copy. With no mailbox at all nothing is queued and no todo is filed
// (noMailboxTodo: null): the enquiry is still in site_leads and shows on the Site page, and notified_at stays NULL so
// a later caller can still send it. The message id is `enquiry:<lead id>`, so one lead can never be emailed twice
// (two callers racing get D1's primary-key error, which is read as "already queued").
//
// D1: the onboarding form read (skipped when site.form is given), sendClientMail's ≤ 5, then one update.
import { enquiryEmail, oneLine } from "./copy.js";
import { sendClientMail } from "../client-mail.js";
import { iso, parseJson } from "../util.js";

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isDuplicateId = (err) => /UNIQUE constraint failed: messages\.id/.test(String(err?.message));

// The onboarding answers: site.form when the caller has them, else onboarding.form.
async function formOf(DB, site) {
  if (isObject(site?.form)) return site.form;
  const row = await DB.prepare("SELECT form FROM onboarding WHERE client_id = ?").bind(site.client_id).first();
  const form = parseJson(row?.form, null);
  return isObject(form) ? form : {};
}

/**
 * Queues the enquiry email for `lead` (a site_leads row) to the business's enquiries address and stamps the row's
 * notified_at (now) and message_id. To is form.business.leads_email; when that's blank (the form requires it), the
 * form's customer email, then the site's own business.email. {queued: true} when an email was queued; {queued: false}
 * when the lead was already notified, there's no address, or there's no mailbox (no todo either way).
 */
export async function notifyLead(DB, lead, site, now = new Date()) {
  if (!lead?.id) throw new Error("notifyLead needs the site_leads row (with its id).");
  if (!site?.client_id) throw new Error("notifyLead needs the client's site.");
  if (lead.notified_at) return { queued: false };
  const form = await formOf(DB, site);
  const content = isObject(site.content) ? site.content : {};
  const to = [form.business?.leads_email, form.business?.email, content.business?.email]
    .map((v) => oneLine(v))
    .find(Boolean);
  if (!to) return { queued: false };
  const business = oneLine(content.business?.name) || oneLine(form.business?.name) || oneLine(site.name);
  const messageId = `enquiry:${lead.id}`;

  let queued = null;
  try {
    ({ queued } = await sendClientMail(DB, {
      id: messageId,
      client_id: site.client_id,
      place_id: site.place_id ?? null,
      to,
      business,
      compose: () => enquiryEmail({ lead, site, business, when: lead.created_at ?? now }),
      now,
      noMailboxTodo: null,
    }));
  } catch (err) {
    if (!isDuplicateId(err)) throw err;
    // Already queued by another caller: make sure the row says so, but don't count a second email.
    await stamp(DB, lead.id, messageId, now);
    return { queued: false };
  }
  if (!queued) return { queued: false };
  await stamp(DB, lead.id, queued, now);
  return { queued: true };
}

// updated_at is left alone: for a chat lead it is the time of the chat's last message.
function stamp(DB, id, messageId, now) {
  const at = iso(now);
  return DB.prepare(
    "UPDATE site_leads SET notified_at = COALESCE(notified_at, ?), message_id = COALESCE(message_id, ?) WHERE id = ?",
  )
    .bind(at, messageId, id)
    .run();
}
