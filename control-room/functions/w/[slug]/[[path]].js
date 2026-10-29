// /w/<slug>/… → the temporary public link to a client's site (stage 10, docs/rebuild/09-build.md section 7, Task 23),
// for when their domain is slow to connect: public on our hosts (PUBLIC_PREFIXES in _middleware.js), only while the
// site is live, noindex, canonical to the client's real host, with a working contact form. The work is
// _lib/sites/preview.js; tested in control-room/tests/sites-preview.test.mjs.
import { servePreview } from "../../_lib/sites/preview.js";

export const onRequest = (context) => servePreview(context, "temporary");
