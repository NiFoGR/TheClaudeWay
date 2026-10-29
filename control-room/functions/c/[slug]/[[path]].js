// /c/<slug>/… → Nik's preview of a client's site (stage 10, docs/rebuild/09-build.md section 7, Task 23): behind the
// login (the middleware's default for any path not public), any status with content, the preview bar, noindex, every
// link under /c/<slug>/, the form and chat replaced by "Works once the site is live." The work is
// _lib/sites/preview.js; tested in control-room/tests/sites-preview.test.mjs.
import { servePreview } from "../../_lib/sites/preview.js";

export const onRequest = (context) => servePreview(context, "preview");
