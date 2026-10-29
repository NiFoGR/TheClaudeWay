// A request body read with a byte limit (stage 10): the onboarding form, the chat and the contact form all read their
// bodies through this, so a body without a Content-Length (chunked) is read only up to the chunk that crosses the
// limit, then the rest of the stream is cancelled. A huge post is never held in memory, decoded or parsed (the free
// plan allows 10 ms of CPU per request). Tested in sites-chat-handler, sites-contact and the onboarding tests.

/** The body's bytes when they are at most `max`, else null (the stream cancelled). No body → empty bytes. */
export async function cappedBytes(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
