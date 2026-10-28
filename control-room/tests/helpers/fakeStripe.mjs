// A fake Stripe API for tests: a fetch that answers https://api.stripe.com/v1/… from a table of routes.
// fakeStripe(routes) → {fetchImpl, calls: [{method, path, params, headers}]}
//
// routes: {"METHOD path": answer}, path as written after /v1/ ("checkout/sessions", "webhook_endpoints/we_0",
// "charges/ch_1?expand[]=balance_transaction"). A route with a query string must match it exactly; otherwise the path
// without its query string is matched. An answer is
//   - an object: returned with status 200 (a Stripe object; its own `status: "active"` text is just a field),
//   - a function (params) → answer: called with the call's params; if it throws, the fetch rejects (network failure),
//   - {status: 400…599, error}: that HTTP status with Stripe's error body; `error` is a message string or an object
//     like {message, type, code}.
// An unknown route answers 404 with "No fake Stripe route for METHOD path", so a test sees what it forgot.
//
// calls[i].params is the form body (or the query string of a GET) decoded back into an object: a[b]=1 → {a: {b: "1"}},
// a[0]=x&a[1]=y → {a: ["x", "y"]}, a= → {a: ""}. Every value comes back as text, as Stripe receives it. Header names are
// lower case. null when nothing was sent.

/** Turn Stripe's form encoding back into nested objects and arrays (values stay text). */
export function decodeForm(text) {
  const search = new URLSearchParams(text);
  if (![...search.keys()].length) return null;
  const root = {};
  for (const [name, value] of search) {
    const [head, ...rest] = name.split("[");
    const keys = [head, ...rest.map((k) => k.replace(/\]$/, ""))];
    let node = root;
    keys.forEach((k, i) => {
      const key = k === "" ? String(Object.keys(node).length) : k; // a[]=x appends
      if (i === keys.length - 1) node[key] = value;
      else node = node[key] && typeof node[key] === "object" ? node[key] : (node[key] = {});
    });
  }
  const arrays = (v) => {
    if (!v || typeof v !== "object") return v;
    const keys = Object.keys(v);
    const out = Object.fromEntries(keys.map((k) => [k, arrays(v[k])]));
    return keys.length && keys.every((k, i) => k === String(i)) ? keys.map((k) => out[k]) : out;
  };
  return arrays(root);
}

const isError = (a) => a && typeof a === "object" && typeof a.status === "number" && a.status >= 400;

export function fakeStripe(routes = {}) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const u = new URL(String(url));
    const bare = decodeURIComponent(u.pathname.replace(/^\/v1\//, ""));
    const query = decodeURIComponent(u.search.slice(1));
    const path = query ? `${bare}?${query}` : bare;
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body === undefined || init.body === null ? "" : String(init.body);
    const params = body ? decodeForm(body) : query ? decodeForm(u.search.slice(1)) : null;
    calls.push({ method, path, params, headers });

    const key = `${method} ${path}` in routes ? `${method} ${path}` : `${method} ${bare}`;
    let answer = routes[key];
    if (answer === undefined) {
      answer = { status: 404, error: { type: "invalid_request_error", message: `No fake Stripe route for ${method} ${path}` } };
    } else if (typeof answer === "function") {
      answer = await answer(params); // a throw here rejects the fetch, like a network failure
    }
    if (isError(answer)) {
      const error = typeof answer.error === "string" ? { message: answer.error } : answer.error || {};
      return new Response(JSON.stringify({ error }), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(answer ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }
  return { fetchImpl, calls };
}
