/**
 * tests/support/buffered_fetch.mjs — read every fetch() body to completion
 * before handing the Response to the suite.
 *
 * Load it with NODE_OPTIONS (no suite needs to change):
 *
 *   NODE_OPTIONS=--import=file:///abs/path/to/tests/support/buffered_fetch.mjs node tests/admin-auth.mjs
 *
 * Why: the suites often check `(await fetch(url)).status` and never read the
 * body. With a body larger than one socket read, undici (Node 22 and 24) pauses
 * its HTTP parser for backpressure; when the PHP built-in server then closes
 * the connection — it answers every request with `Connection: close` — the
 * parser's end handler hits `assert(!this.paused)` and the whole process aborts
 * with ERR_ASSERTION, mid-suite, with no test output. Reading the body first
 * means the parser is never paused when the socket ends.
 *
 * What changes for a suite: nothing observable. Status, headers (including
 * every Set-Cookie), url, redirected and the body are all preserved; `.text()`,
 * `.json()` and `.arrayBuffer()` work as before. Bodies are small (HTML pages
 * and JSON), so buffering costs nothing measurable.
 */

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const original = globalThis.fetch;

globalThis.fetch = async function bufferedFetch(input, init) {
  const r = await original(input, init);
  const bytes = NULL_BODY_STATUS.has(r.status) ? null : Buffer.from(await r.arrayBuffer());
  const out = new Response(bytes, { status: r.status, statusText: r.statusText, headers: r.headers });
  for (const prop of ["url", "redirected", "type"]) {
    Object.defineProperty(out, prop, { value: r[prop], enumerable: true });
  }
  return out;
};
