// Review link, review-request templates and client site emails (stage 10, Task 9).
// Run: node --test control-room/tests/sites-copy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkReviewLink, cnameEmail, enquiryEmail, goLiveEmail, nameserverEmail, oneLine, reviewMessages, reviewUrl,
} from "../functions/_lib/sites/copy.js";

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const L = `https://search.google.com/local/writereview?placeid=${PLACE}`;
const BANNED = /happy|satisf|discount|voucher|prize|free gift|entry|draw|only if/i;

test("checkReviewLink accepts Google review links over https only", () => {
  assert.ok(checkReviewLink("https://g.page/r/abc/review").ok);
  assert.equal(checkReviewLink("https://g.page/r/abc/review").url, "https://g.page/r/abc/review");
  assert.equal(checkReviewLink("https://evil.com/x").error, "That isn't a Google review link.");
  assert.equal(checkReviewLink("http://g.page/r/abc").ok, false);
  for (const ok of [L, "https://www.google.com/maps/place/x", "https://google.com/search?q=x", "https://maps.app.goo.gl/abc"]) {
    assert.ok(checkReviewLink(ok).ok, ok);
  }
  for (const bad of ["", "   ", null, "g.page/r/abc", "https://g.page.evil.com/r", "https://evil.com/?u=https://g.page/r",
    "https://g.page@evil.com/r", "https://www.google.com/url?q=https://evil.com", "javascript:alert(1)",
    "https://g.page/r/a b"]) {
    const r = checkReviewLink(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.error, "That isn't a Google review link.");
  }
});

test("reviewUrl: the form's link, else Nik's, else the place id's write-a-review link, else none", () => {
  assert.equal(reviewUrl({ placeId: PLACE }), L);
  assert.equal(reviewUrl({ formLink: "https://g.page/r/form/review", nikLink: "https://g.page/r/nik/review", placeId: PLACE }),
    "https://g.page/r/form/review");
  assert.equal(reviewUrl({ formLink: "https://bit.ly/x", nikLink: "https://g.page/r/nik/review", placeId: PLACE }),
    "https://g.page/r/nik/review");
  assert.equal(reviewUrl({ formLink: "", nikLink: "https://evil.com", placeId: PLACE }), L);
  assert.equal(reviewUrl({ formLink: "https://evil.com" }), null);
  assert.equal(reviewUrl({}), null);
  assert.equal(reviewUrl(), null);
});

test("the three review-request templates are section 12's text", () => {
  const m = reviewMessages({ business: "Smith Roofing", owner: "John", link: L });
  assert.equal(m.sms, `Hi {customer}, thanks for choosing Smith Roofing. If you have a minute, could you leave us a Google review? It really helps a small local business: ${L} Thanks, John`);
  assert.deepEqual(m.email, {
    subject: "Thanks from Smith Roofing",
    body: `Hi {customer},\n\nThanks for choosing Smith Roofing. If you have a minute, could you leave us a Google review? It really helps a small local business, and it only takes a minute:\n\n${L}\n\nThanks,\nJohn`,
  });
  assert.equal(m.reminder, `Hi {customer}, just a quick reminder in case you missed it: if you could leave Smith Roofing a Google review, it would mean a lot. ${L} No worries if not. John`);
  for (const text of [m.sms, m.email.subject, m.email.body, m.reminder]) assert.doesNotMatch(text, BANNED);
});

test("review templates sign with the business name when no owner name, and a name can't break a line", () => {
  const m = reviewMessages({ business: "Smith\r\nRoofing", owner: "", link: L });
  assert.match(m.sms, /Thanks, Smith Roofing$/);
  assert.equal(m.email.subject, "Thanks from Smith Roofing");
  assert.doesNotMatch(m.email.subject, /[\r\n]/);
});

test("oneLine strips CR/LF, trims and keeps at most 200 characters", () => {
  assert.equal(oneLine("  Dave\r\nBcc: x@y.z \n"), "Dave Bcc: x@y.z");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine("x".repeat(300)).length, 200);
  assert.doesNotMatch(oneLine("a\rb\nc\u2028d"), /[\r\n\u2028]/);
});

test("enquiryEmail: subject has no CR/LF, body is section 12's text", () => {
  const when = new Date("2026-10-28T14:05:00Z"); // GMT after 25 Oct: 14:05 UK
  const lead = { name: "Dave\r\nBcc: x@y.z", phone: "07700 900123", email: "dave@example.com", message: "Leak over the porch", page: "/contact" };
  const e = enquiryEmail({ lead, site: { host: "www.smithroofing.co.uk" }, business: "Smith Roofing", when });
  assert.equal(e.subject, "New enquiry from your website: Dave Bcc: x@y.z");
  assert.doesNotMatch(e.subject, /[\r\n]/);
  assert.equal(e.body, "Dave Bcc: x@y.z sent this from /contact on Wed 28 Oct, 14:05:\n\nName: Dave Bcc: x@y.z\nPhone: 07700 900123\nEmail: dave@example.com\n\nLeak over the porch\n\nReply to them directly (not to this email). Sent by your website, built by Aetos Websites.");
});

test("enquiryEmail without a name says someone, and leaves out empty details", () => {
  const e = enquiryEmail({
    lead: { name: "", phone: "07700900123", email: "", message: "Visitor: hi\nAssistant: hello", page: "/services/roof-repairs" },
    business: "Smith Roofing", when: "2026-07-01T08:30:00Z", // BST: 09:30 UK
  });
  assert.equal(e.subject, "New enquiry from your website: someone");
  assert.match(e.body, /^Someone sent this from \/services\/roof-repairs on Wed 1 Jul, 09:30:\n\n/);
  assert.match(e.body, /Phone: 07700900123\n\nVisitor: hi\nAssistant: hello\n\n/);
  assert.doesNotMatch(e.body, /Name:|Email:/);
});

test("goLiveEmail: chat and review lines only when they apply", () => {
  const base = { first: "John", host: "www.smithroofing.co.uk", leadsEmail: "john@smithroofing.co.uk", nik: "Nikiforos" };
  const plain = goLiveEmail({ ...base, chatOn: false, fullPackage: true, reviewUrl: null });
  assert.equal(plain.subject, "Your website is live: www.smithroofing.co.uk");
  assert.equal(plain.body, "Hi John,\n\nYour new website is live: https://www.smithroofing.co.uk\n\nHave a look and tell me anything you'd like changed: just reply to this email.\n\nWebsite enquiries go to john@smithroofing.co.uk.\n\nNikiforos\nAetos Websites");
  assert.doesNotMatch(plain.body, /chat assistant/);
  assert.doesNotMatch(plain.body, /review-card/);

  const full = goLiveEmail({ ...base, chatOn: true, fullPackage: true, reviewUrl: L });
  assert.match(full.body, /https:\/\/www\.smithroofing\.co\.uk\/s\/review-card/);
  assert.equal(full.body, "Hi John,\n\nYour new website is live: https://www.smithroofing.co.uk\n\nHave a look and tell me anything you'd like changed: just reply to this email.\n\nWebsite enquiries go to john@smithroofing.co.uk. The chat assistant on your site answers questions day and night and sends you anyone who leaves their number.\n\nThe quickest way up Google Maps is a steady stream of reviews. Ask every customer when you finish a job. Your review link, a printable QR card and ready-made text messages are here: https://www.smithroofing.co.uk/s/review-card\n\nNikiforos\nAetos Websites");

  const websiteOnly = goLiveEmail({ ...base, chatOn: false, fullPackage: false, reviewUrl: L });
  assert.doesNotMatch(websiteOnly.body, /review-card/);
});

test("goLiveEmail: no first name greets with Hi, and no sign name signs Nik; subject is one line", () => {
  const e = goLiveEmail({ first: "", host: "www.x.co.uk\r\n", leadsEmail: "a@x.co.uk", nik: "" });
  assert.match(e.body, /^Hi,\n\n/);
  assert.match(e.body, /\n\nNik\nAetos Websites$/);
  assert.equal(e.subject, "Your website is live: www.x.co.uk");
});

test("nameserverEmail: section 7's text, email line only when they use email on the domain", () => {
  const args = { first: "John", domain: "smithroofing.co.uk", registrar: "GoDaddy", ns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], emailOnIt: "yes", nik: "Nikiforos" };
  const yes = nameserverEmail(args);
  assert.equal(yes.subject, "One quick job for your new website");
  assert.equal(yes.body, "Hi John,\n\nOne quick job so your new website shows on smithroofing.co.uk. Log in to GoDaddy, open smithroofing.co.uk, find \"Nameservers\" (sometimes under DNS or Advanced), choose \"custom\" and replace what's there with these two:\n\nada.ns.cloudflare.com\nbob.ns.cloudflare.com\n\nSave, and that's it. Your email keeps working: we've copied its settings across. It can take a few hours to switch over.\n\nIf you'd rather I talk you through it, reply with a good time to call.\n\nNikiforos");
  assert.match(nameserverEmail({ ...args, emailOnIt: "not_sure" }).body, /Your email keeps working/);
  const no = nameserverEmail({ ...args, emailOnIt: "no", registrar: "" });
  assert.doesNotMatch(no.body, /Your email keeps working/);
  assert.match(no.body, /Save, and that's it\. It can take a few hours to switch over\./);
  assert.match(no.body, /Log in to the company you bought your domain from, open/);
  assert.throws(() => nameserverEmail({ ...args, ns: [] }), /two nameservers/);
});

test("cnameEmail: section 7's text", () => {
  const e = cnameEmail({ first: "John", domain: "smithroofing.co.uk", registrar: "123-reg", pagesHost: "goldbarwebsites.pages.dev", nik: "Nikiforos" });
  assert.equal(e.subject, "One quick job for your new website");
  assert.equal(e.body, "Hi John,\n\nOne quick job so your new website shows on smithroofing.co.uk. Whoever looks after your domain (123-reg) needs to make two changes in its DNS settings:\n\n1. Add a CNAME record: name \"www\", target \"goldbarwebsites.pages.dev\" (remove any old \"www\" record first).\n2. Forward smithroofing.co.uk to https://www.smithroofing.co.uk\n\nYour email isn't affected. Forward this email to them if that's easiest.\n\nNikiforos");
  const unknown = cnameEmail({ first: "John", domain: "smithroofing.co.uk", registrar: "", pagesHost: "goldbarwebsites.pages.dev", nik: "Nik" });
  assert.match(unknown.body, /\(the company you bought it from, or the person who built your old site\)/);
});

test("review templates never cut a long Google Maps link short", () => {
  const long = `https://www.google.com/maps/place/Smith+Roofing/@51.5,-1.8,17z/data=${"x".repeat(300)}`;
  assert.ok(checkReviewLink(long).ok);
  const m = reviewMessages({ business: "Smith Roofing", owner: "John", link: long });
  for (const text of [m.sms, m.email.body, m.reminder]) assert.ok(text.includes(long));
});

test("checkReviewLink refuses google.com click-through redirectors", () => {
  for (const bad of ["https://www.google.com/aclk?adurl=https://evil.com", "https://www.google.com/imgres?imgrefurl=https://evil.com",
    "https://google.com/amp/s/evil.com", "https://www.google.com/linkredirect?dest=https://evil.com"]) {
    assert.equal(checkReviewLink(bad).ok, false, bad);
  }
});

test("enquiryEmail for a chat lead with no page says your website, not a page they weren't on", () => {
  const e = enquiryEmail({ lead: { name: "Sue", phone: "07700900123", message: "Visitor: hi", page: null }, when: "2026-10-28T14:05:00Z" });
  assert.match(e.body, /^Sue sent this from your website on Wed 28 Oct, 14:05:/);
});

test("domain emails refuse to go out incomplete", () => {
  const ns = { first: "John", domain: "smithroofing.co.uk", ns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], nik: "Nik" };
  assert.throws(() => nameserverEmail({ ...ns, ns: ["ada.ns.cloudflare.com"] }), /two nameservers/);
  assert.throws(() => nameserverEmail({ ...ns, ns: ["a.ns.cloudflare.com", "b.ns.cloudflare.com", "c.ns.cloudflare.com"] }), /two nameservers/);
  assert.throws(() => nameserverEmail({ ...ns, ns: ["ada.ns.cloudflare.com", "ada.ns.cloudflare.com"] }), /two nameservers/);
  assert.throws(() => nameserverEmail({ ...ns, domain: " " }), /domain/);
  const cn = { first: "John", domain: "smithroofing.co.uk", registrar: "", pagesHost: "goldbarwebsites.pages.dev", nik: "Nik" };
  assert.throws(() => cnameEmail({ ...cn, pagesHost: "" }), /Pages address/);
  assert.throws(() => cnameEmail({ ...cn, domain: "" }), /domain/);
});
