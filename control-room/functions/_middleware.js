// Password gate for the whole Control Room. One password (CONTROL_ROOM_PASSWORD), a signed cookie for 30 days.
const COOKIE = "cr_session";
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/style.css", "/favicon.svg", "/robots.txt"]);

async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("goldbar-control-room-session"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const match = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : "";
}

const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!env.CONTROL_ROOM_PASSWORD) {
    return new Response("Set CONTROL_ROOM_PASSWORD in the Cloudflare Pages settings, then redeploy.", { status: 500 });
  }
  const token = await sessionToken(env.CONTROL_ROOM_PASSWORD);
  const secure = url.protocol === "https:" ? "; Secure" : "";

  if (url.pathname === "/login" && request.method === "POST") {
    const form = await request.formData();
    const attempt = await sessionToken(String(form.get("password") || ""));
    if (!safeEqual(attempt, token)) return redirect("/login?wrong=1");
    return redirect("/", { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}` });
  }
  if (url.pathname === "/logout") {
    return redirect("/login", { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
  }
  if (PUBLIC_PATHS.has(url.pathname)) return next();

  if (!safeEqual(readCookie(request, COOKIE), token)) {
    if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "Not logged in" }), { status: 401 });
    return redirect("/login");
  }
  return next();
}
