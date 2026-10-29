// The chat widget served at /s/chat.js on client sites (pure; stage 10, section 11). One small IIFE, ≤ 8 KB, no
// external requests (it only POSTs to "/s/chat" on the client's own host), loaded with `defer`. A round button
// "Questions? Ask us" sits bottom-right (bottom-left under 900 px, above the mobile call bar, so it never covers the
// call button); the panel's DOM is built only when it's first opened. Every message is shown with textContent, never
// as HTML. The session id is random and kept in sessionStorage (wrapped in try/catch: private windows can throw). It
// sends the last 6 turns. The only values from outside are the business name and the first 3 services, injected as
// JSON with every "<" escaped, so a name like "</script>" can't end the script or add markup.

const NAME_MAX = 120;
const SERVICE_MAX = 80;
const MAX_BYTES = 8192;

// Control characters become spaces, whitespace runs collapse, and the cut is by code point (never half an emoji).
function clean(value, max) {
  const s = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

function serviceName(s) {
  return clean(s && typeof s === "object" ? s.name : s, SERVICE_MAX);
}

// JSON with every "<" escaped (so "</script>" can't close a tag) and everything outside ASCII escaped too, so the
// script reads the same whatever charset the browser assumes.
function js(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c")
    .replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function chatWidgetJs({ business, services } = {}) {
  const name = clean(business, NAME_MAX);
  const named = (Array.isArray(services) ? services : []).map(serviceName).filter(Boolean).slice(0, 3);
  // The name and services go in once each; the title and first message are put together in the browser. Escaping can
  // grow a value up to 6x ("<" → \u003c), so if a hostile name would push the script past 8 KB, services are dropped
  // and then the name is shortened until it fits.
  let out = script(name, named);
  for (let n = named.length - 1; n >= 0 && bytes(out) > MAX_BYTES; n--) out = script(name, named.slice(0, n));
  for (let cut = Array.from(name).length - 10; cut >= 0 && bytes(out) > MAX_BYTES; cut -= 10) out = script(clean(name, cut), []);
  return out;
}

function bytes(s) {
  return new TextEncoder().encode(s).length;
}

function script(name, named) {
  return `(function(){
"use strict";
var N=${js(name)},V=${js(named)};
var T=N?N+" \\u00b7 virtual assistant":"Virtual assistant",HI="Hi! I'm "+(N?N+"'s":"the")+" virtual assistant. Ask me about "+
(V.length?V.join(", "):"what we do")+" or the areas we cover"+
". If you'd like a call back, just leave your name and number.";
var K="aetos-chat-sid",S=null,H=[],busy=false,panel,log,input,send,btn;
if(document.getElementById("ae-chat-btn"))return;
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
function gen(){var a="abcdefghijklmnopqrstuvwxyz0123456789",s="",b=null;
try{b=window.crypto.getRandomValues(new Uint8Array(24))}catch(e){}
for(var i=0;i!==24;i++)s+=a.charAt((b?b[i]:Math.floor(Math.random()*256))%36);return s}
function sid(){if(S)return S;
try{S=window.sessionStorage.getItem(K)}catch(e){}
if(!S||!/^[a-z0-9]{16,40}$/.test(S)){S=gen();try{window.sessionStorage.setItem(K,S)}catch(e){}}
return S}
function css(){var st=document.createElement("style");st.textContent=
"#ae-chat-btn{position:fixed;right:20px;bottom:20px;z-index:30;border:0;border-radius:999px;padding:14px 20px;background:var(--main,#1a1c20);color:#fff;font:600 15px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}"+
"#ae-chat{position:fixed;right:20px;bottom:80px;z-index:31;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:#fff;color:#1a1c20;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);font:15px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;overflow:hidden}"+
"#ae-chat[hidden]{display:none}"+
".ae-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--main,#1a1c20);color:#fff;font-weight:600}"+
".ae-x{background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px}"+
".ae-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f5f5f6}"+
".ae-m{max-width:85%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}"+
".ae-a{align-self:flex-start;background:#fff;border:1px solid #e2e2e5}"+
".ae-u{align-self:flex-end;background:var(--main,#1a1c20);color:#fff}"+
".ae-f{display:flex;gap:8px;padding:10px 10px 6px;border-top:1px solid #e2e2e5}"+
".ae-f input{flex:1;min-width:0;padding:10px;border:1px solid #c8c8cd;border-radius:8px;font:inherit;color:inherit;background:#fff}"+
".ae-f button{padding:10px 14px;border:0;border-radius:8px;background:var(--main,#1a1c20);color:#fff;font:inherit;font-weight:600;cursor:pointer}"+
".ae-f button:disabled,.ae-f input:disabled{opacity:.6}"+
".ae-n{margin:0;padding:0 12px 10px;font-size:12px;color:#55555b}"+
"@media (max-width:899.98px){#ae-chat-btn{right:auto;left:16px;bottom:16px}body.has-call #ae-chat-btn{bottom:76px}#ae-chat{right:8px;left:8px;bottom:8px;width:auto;max-width:none;height:70vh;max-height:none}}";
document.head.appendChild(st)}
function add(who,text){var m=el("div","ae-m "+(who==="user"?"ae-u":"ae-a"),text);log.appendChild(m);log.scrollTop=log.scrollHeight;return m}
function build(){panel=el("div");panel.id="ae-chat";panel.setAttribute("role","dialog");panel.setAttribute("aria-label",T);
var head=el("div","ae-h"),t=el("span","",T),x=el("button","ae-x","\\u00d7");x.type="button";x.setAttribute("aria-label","Close the chat");
x.addEventListener("click",function(){toggle(false)});head.appendChild(t);head.appendChild(x);
log=el("div","ae-log");log.setAttribute("aria-live","polite");
var f=el("form","ae-f");input=el("input");input.type="text";input.setAttribute("maxlength","500");input.setAttribute("autocomplete","off");
input.setAttribute("aria-label","Your message");input.setAttribute("placeholder","Type your question");
send=el("button","","Send");send.type="submit";f.appendChild(input);f.appendChild(send);f.addEventListener("submit",submit);
panel.appendChild(head);panel.appendChild(log);panel.appendChild(f);panel.appendChild(el("p","ae-n","AI assistant. Please don't share card or bank details."));
document.body.appendChild(panel);add("assistant",HI)}
function toggle(open){if(open&&!panel)build();if(!panel)return;panel.hidden=!open;btn.setAttribute("aria-expanded",open?"true":"false");
if(open)input.focus();else btn.focus()}
function wait(on){busy=on;input.disabled=on;send.disabled=on}
function submit(e){if(e&&e.preventDefault)e.preventDefault();var text=String(input.value||"").trim().slice(0,500);
if(!text||busy)return Promise.resolve();add("user",text);input.value="";wait(true);var m=add("assistant","\\u2026");
return fetch("/s/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sid:sid(),history:H.slice(-6),text:text})})
.then(function(r){if(!r.ok)throw new Error("status");return r.json()})
.then(function(d){var reply=String(d&&d.reply||"").slice(0,600);if(!reply)throw new Error("empty");m.textContent=reply;
H.push({role:"user",content:text},{role:"assistant",content:reply});if(H.length>12)H=H.slice(-12)})
.catch(function(){m.textContent="Sorry, that didn't go through. Please try again in a moment."})
.then(function(){wait(false);log.scrollTop=log.scrollHeight;input.focus()})}
function start(){css();btn=el("button","","Questions? Ask us");btn.id="ae-chat-btn";btn.type="button";btn.setAttribute("aria-expanded","false");
btn.setAttribute("aria-haspopup","dialog");document.addEventListener("keydown",function(e){if(e.key==="Escape"&&panel&&!panel.hidden)toggle(false)});btn.addEventListener("click",function(){toggle(!panel||panel.hidden)});document.body.appendChild(btn)}
if(document.body)start();else document.addEventListener("DOMContentLoaded",start);
})();
`;
}
