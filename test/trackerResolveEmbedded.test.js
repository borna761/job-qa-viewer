// Integration test for GET /api/tracker/resolve-embedded-job-info. Mounts
// the real app, same pattern as routes.test.js. This route calls the real
// global fetch() internally to reach the (untrusted, client-supplied)
// embedded URL — the test's own HTTP client to the local server *also* uses
// global fetch, so the mock below has to selectively intercept only the
// embedded-URL call and pass everything else through to the real fetch,
// rather than replacing global.fetch outright.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-embedded-'));
process.env.JOBTRACKER_DATA_DIR = tmp;
process.env.JOBTRACKER_ORDER_FILE = path.join(tmp, 'order.json');
process.env.JOBTRACKER_CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');

let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const getJson = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};

let realFetch;
beforeEach(() => { realFetch = global.fetch; });
afterEach(() => { global.fetch = realFetch; });

function mockEmbeddedFetch(embeddedUrl, response) {
  global.fetch = async (url, opts) => {
    if (String(url) === embeddedUrl) return response;
    return realFetch(url, opts); // the test's own call to the local server
  };
}

test('resolve-embedded-job-info: rejects a disallowed (non-allow-listed) host', async () => {
  const { status, body } = await getJson('/api/tracker/resolve-embedded-job-info?url=' + encodeURIComponent('https://evil.example.com/x'));
  assert.equal(status, 400);
  assert.match(body.error, /Invalid or disallowed URL/);
});

test('resolve-embedded-job-info: rejects a missing url param', async () => {
  const { status } = await getJson('/api/tracker/resolve-embedded-job-info');
  assert.equal(status, 400);
});

test('resolve-embedded-job-info: fetches an allow-listed URL and returns its JobPosting role+company', async () => {
  const embeddedUrl = 'https://jobs.ashbyhq.com/Acme/abc-123';
  mockEmbeddedFetch(embeddedUrl, {
    ok: true,
    text: async () => `<html><script type="application/ld+json">
      {"@type":"JobPosting","title":"Product Engineer","hiringOrganization":{"name":"Acme"}}
    </script></html>`,
  });

  const { status, body } = await getJson('/api/tracker/resolve-embedded-job-info?url=' + encodeURIComponent(embeddedUrl));
  assert.equal(status, 200);
  assert.deepEqual(body, { role: 'Product Engineer', company: 'Acme' });
});

test('resolve-embedded-job-info: returns 404 when the fetched page has no usable JobPosting data', async () => {
  const embeddedUrl = 'https://jobs.ashbyhq.com/Acme/no-jsonld';
  mockEmbeddedFetch(embeddedUrl, { ok: true, text: async () => '<html>no structured data</html>' });

  const { status, body } = await getJson('/api/tracker/resolve-embedded-job-info?url=' + encodeURIComponent(embeddedUrl));
  assert.equal(status, 404);
  assert.match(body.error, /No JobPosting data found/);
});

test('resolve-embedded-job-info: returns 404 (not a 500) when the fetch itself fails', async () => {
  const embeddedUrl = 'https://jobs.ashbyhq.com/Acme/unreachable';
  global.fetch = async (url, opts) => {
    if (String(url) === embeddedUrl) throw new Error('network down');
    return realFetch(url, opts);
  };

  const { status } = await getJson('/api/tracker/resolve-embedded-job-info?url=' + encodeURIComponent(embeddedUrl));
  assert.equal(status, 404);
});
