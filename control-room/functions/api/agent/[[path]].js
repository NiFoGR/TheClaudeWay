// /api/agent/* that no Routine route answers (e.g. the removed POST /api/agent/leads/:id, which wrote
// audit.ai_research), or a real route called with the wrong method (GET on a POST-only route): a JSON 404. The
// middleware lets /api/agent/* through without the login cookie, so without this a GET would fall through to Pages'
// single-page-app fallback (the Control Room's index.html, 200) and a POST to the static-asset handler (405). Every
// real agent route is more specific, so Pages runs it first. Tested in tests/research.test.mjs.
import { bad } from "../../_lib/util.js";

export const onRequest = ({ request }) => {
  const { method } = request;
  const path = new URL(request.url).pathname.slice(0, 200);
  const res = bad(`No such Control Room address: ${method} ${path}. Check the address and the method (GET or POST) in the Routine's prompt.`, 404);
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
};
