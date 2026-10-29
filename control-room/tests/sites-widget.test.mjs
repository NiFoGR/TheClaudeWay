// The chat widget script served at /s/chat.js on client sites (stage 10, Task 21).
// Run: node --test control-room/tests/sites-widget.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chatWidgetJs } from "../functions/_lib/sites/widget.js";

const SERVICES = [{ name: "Roof repairs" }, { name: "Flat roofs" }, { name: "Guttering" }, { name: "Chimneys" }];
const js = chatWidgetJs({ business: "Smith Roofing", services: SERVICES });

test("the output parses as JavaScript", () => {
  assert.equal(typeof js, "string");
  assert.doesNotThrow(() => new Function(js));
});

test("the script is at most 8,192 bytes", () => {
  assert.ok(new TextEncoder().encode(js).length <= 8192, `${new TextEncoder().encode(js).length} bytes`);
  const long = chatWidgetJs({ business: "B".repeat(120), services: Array.from({ length: 12 }, (_, i) => ({ name: `Service ${i} ${"x".repeat(60)}` })) });
  assert.ok(new TextEncoder().encode(long).length <= 8192);
  assert.doesNotThrow(() => new Function(long));
});

test("it carries the button, title, first message and the warning under the input", () => {
  assert.ok(js.includes("Questions? Ask us"));
  assert.ok(js.includes("virtual assistant"));
  assert.ok(js.includes("AI assistant. Please don't share card or bank details."));
  assert.ok(js.includes("Smith Roofing"));
  assert.ok(js.includes("Roof repairs") && js.includes("Flat roofs") && js.includes("Guttering"));
  assert.ok(!js.includes("Chimneys"), "only the first 3 services are named");
  assert.ok(js.includes("If you'd like a call back, just leave your name and number."));
});

test("it posts to /s/chat on the same host and makes no external requests", () => {
  assert.ok(js.includes('"/s/chat"'));
  assert.ok(!js.includes("http://"));
  assert.ok(!js.includes("https://"));
});

test("sessionStorage is used only inside a try", () => {
  assert.ok(js.includes("sessionStorage"));
  const at = js.indexOf("sessionStorage");
  const before = js.slice(0, at);
  const tryAt = before.lastIndexOf("try");
  assert.ok(tryAt >= 0, "no try before sessionStorage");
  const between = js.slice(tryAt, at);
  assert.ok(!between.includes("catch"), "sessionStorage is not inside the try block");
  for (let i = js.indexOf("sessionStorage"); i >= 0; i = js.indexOf("sessionStorage", i + 1)) {
    const t = js.lastIndexOf("try{", i);
    const seg = js.slice(t + 4, i);
    assert.ok(t >= 0 && !seg.includes("catch"), `sessionStorage at ${i} is outside a try`);
    // still inside the try's braces: every "}" after "try{" is matched by a "{"
    let depth = 1;
    for (const ch of seg) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    assert.ok(depth >= 1, `sessionStorage at ${i} is after its try block closed`);
  }
});

test("hostile or long names never push it past 8,192 bytes, and the output is plain ASCII", () => {
  const cases = [
    { business: "<".repeat(300), services: Array(6).fill("<".repeat(300)) },
    { business: "\u0001".repeat(300), services: Array(6).fill("\u0001".repeat(300)) },
    { business: "\u6f22".repeat(300), services: Array(6).fill({ name: "\u6f22".repeat(300) }) },
    { business: "\ud83d\ude00".repeat(300), services: Array(6).fill("\ud83d\ude00".repeat(300)) },
    { business: '"\\'.repeat(300), services: Array(6).fill('"\\'.repeat(300)) },
  ];
  for (const c of cases) {
    const out = chatWidgetJs(c);
    assert.ok(new TextEncoder().encode(out).length <= 8192, `${new TextEncoder().encode(out).length} bytes`);
    assert.doesNotThrow(() => new Function(out));
    assert.ok(!out.includes("</script>"));
  }
  for (const out of [js, chatWidgetJs({ business: "Caf\u00e9 R\u00f6\u00f6fing \ud83d\ude00", services: ["\u00c9tanch\u00e9it\u00e9"] })]) {
    assert.ok(/^[\x00-\x7f]*$/.test(out), "every character is ASCII, so the charset doesn't matter");
  }
  const emoji = chatWidgetJs({ business: "x" + "\ud83d\ude00".repeat(200) });
  assert.ok(emoji.includes('var N="x\\ud83d\\ude00'));
  assert.ok(!emoji.includes('\\ud83d",'), "never cut half an emoji");
});

test("bottom-right on wide screens, bottom-left under 900 px and above the call bar", () => {
  assert.ok(js.includes("#ae-chat-btn{position:fixed;right:20px;bottom:20px"));
  assert.ok(js.includes("@media (max-width:899.98px){#ae-chat-btn{right:auto;left:16px;bottom:16px}body.has-call #ae-chat-btn{bottom:76px}"));
});

test("a business name with </script> is JSON-encoded, so the output has no </script>", () => {
  const bad = chatWidgetJs({ business: "</script><x>", services: [{ name: "</script><svg onload=alert(1)>" }] });
  assert.ok(!bad.includes("</script>"));
  assert.ok(!bad.includes("<x>"));
  assert.ok(!bad.includes("<"), "every < from the inputs is escaped");
  assert.ok(bad.includes("\\u003c/script>\\u003cx>"));
  assert.doesNotThrow(() => new Function(bad));
  const quotes = chatWidgetJs({ business: 'Bob\'s "Best" \\ Roofing\u2028', services: ["Roof repairs"] });
  assert.doesNotThrow(() => new Function(quotes));
});

test("message text is set with textContent, never innerHTML", () => {
  assert.ok(js.includes("textContent"));
  assert.ok(!js.includes("innerHTML"));
  assert.ok(!js.includes("outerHTML"));
  assert.ok(!js.includes("insertAdjacentHTML"));
  assert.ok(!js.includes("document.write"));
  assert.ok(!/\beval\b/.test(js));
});

test("services may be names or {name} objects; none at all still reads well", () => {
  const s = chatWidgetJs({ business: "Smith Roofing", services: ["Roof repairs", "Flat roofs"] });
  assert.ok(s.includes("Roof repairs") && s.includes("Flat roofs"));
  const none = chatWidgetJs({ business: "Smith Roofing", services: [] });
  assert.doesNotThrow(() => new Function(none));
  assert.ok(none.includes("or the areas we cover"));
  assert.ok(!none.includes("about  or"));
});

// Runs the script against a tiny fake DOM to check it builds the panel only when opened, sends the last 6 turns and
// shows the reply as text.
function fakeDom() {
  const els = [];
  function el(tag) {
    const e = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, style: {}, listeners: {}, textContent: "", value: "", disabled: false, hidden: false,
      className: "", id: "", type: "",
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      focus() {}, scrollTop: 0, scrollHeight: 0,
    };
    els.push(e);
    return e;
  }
  const body = el("body");
  const head = el("head");
  const document = {
    body, head, readyState: "complete",
    createElement: el,
    getElementById: (id) => els.find((e) => e.id === id) || null,
    addEventListener() {},
  };
  return { document, els };
}

function texts(e, out = []) {
  if (e.textContent) out.push(e.textContent);
  for (const c of e.children) texts(c, out);
  return out;
}

test("it builds its panel only when opened, sends the last 6 turns and shows the reply as text", async () => {
  const { document, els } = fakeDom();
  const calls = [];
  const store = {};
  const window = {
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255; return a; } },
  };
  let n = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    n++;
    return { ok: true, json: async () => ({ reply: n === 1 ? "<b>We cover Wroughton.</b>" : `Answer ${n}`, fallback: false, lead_saved: false }) };
  };
  const run = new Function("window", "document", "fetch", "sessionStorage", "crypto", js);
  run(window, document, fetch, window.sessionStorage, window.crypto);
  const btn = els.find((e) => e.tagName === "BUTTON" && e.textContent === "Questions? Ask us");
  assert.ok(btn, "the round button is there");
  assert.ok(!els.some((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA"), "no panel before it's opened");
  btn.listeners.click[0]({ preventDefault() {} });
  const input = els.find((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA");
  assert.ok(input, "the panel is built on open");
  const all = texts(document.body).join("\n");
  assert.ok(all.includes("Smith Roofing · virtual assistant"));
  assert.ok(all.includes("Hi! I'm Smith Roofing's virtual assistant. Ask me about Roof repairs, Flat roofs, Guttering or the areas we cover. If you'd like a call back, just leave your name and number."));
  assert.ok(all.includes("AI assistant. Please don't share card or bank details."));
  assert.equal(els.filter((e) => e.id === "ae-chat").length, 1);
  btn.listeners.click[0]({ preventDefault() {} });
  btn.listeners.click[0]({ preventDefault() {} });
  assert.equal(els.filter((e) => e.id === "ae-chat").length, 1, "reopening reuses the same panel");
  const form = els.find((e) => e.tagName === "FORM");
  for (let i = 1; i <= 5; i++) {
    input.value = `Question ${i}`;
    await form.listeners.submit[0]({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(calls.length, 5);
  assert.equal(calls[0].url, "/s/chat");
  assert.match(calls[0].body.sid, /^[a-z0-9]{16,40}$/);
  assert.equal(calls[0].body.text, "Question 1");
  assert.deepEqual(calls[0].body.history, []);
  const last = calls[4].body;
  assert.equal(last.text, "Question 5");
  assert.equal(last.history.length, 6);
  assert.deepEqual(last.history.at(-1), { role: "assistant", content: "Answer 4" });
  assert.deepEqual(last.history[0], { role: "user", content: "Question 2" });
  assert.equal(calls[4].body.sid, calls[0].body.sid);
  assert.ok(Object.values(store).includes(calls[0].body.sid), "the session id is kept in sessionStorage");
  const shown = texts(document.body);
  assert.ok(shown.includes("<b>We cover Wroughton.</b>"), "the reply is shown as plain text");
});

test("an accented name and one service read naturally in the browser", () => {
  const { document, els } = fakeDom();
  const out = chatWidgetJs({ business: "Caf\u00e9 Roofing", services: [{ name: "Roof repairs" }] });
  new Function("window", "document", "fetch", out)({}, document, async () => ({}));
  els.find((e) => e.textContent === "Questions? Ask us").listeners.click[0]({});
  const all = texts(document.body).join("\n");
  assert.ok(all.includes("Caf\u00e9 Roofing \u00b7 virtual assistant"));
  assert.ok(all.includes("Hi! I'm Caf\u00e9 Roofing's virtual assistant. Ask me about Roof repairs or the areas we cover. If you'd like"));
});

test("it still works when sessionStorage throws", async () => {
  const { document, els } = fakeDom();
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const window = { sessionStorage: bad, crypto: { getRandomValues: (a) => a.fill(7) } };
  const sent = [];
  const fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: false, status: 500, json: async () => ({}) }; };
  const run = new Function("window", "document", "fetch", "sessionStorage", "crypto", js);
  assert.doesNotThrow(() => run(window, document, fetch, bad, window.crypto));
  const btn = els.find((e) => e.tagName === "BUTTON" && e.textContent === "Questions? Ask us");
  btn.listeners.click[0]({ preventDefault() {} });
  const input = els.find((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA");
  input.value = "Hello";
  await els.find((e) => e.tagName === "FORM").listeners.submit[0]({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.match(sent[0].sid, /^[a-z0-9]{16,40}$/);
  assert.ok(texts(document.body).some((t) => t.includes("didn't go through")), "a failed send says so");
});
