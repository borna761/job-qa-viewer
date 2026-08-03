const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { notionFetch } = require('../lib/notion');

// notionFetch reads process.env.NOTION_TOKEN and calls the global fetch —
// stub both per test so this never touches the real Notion API.
let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  process.env.NOTION_TOKEN = 'test-token';
});
afterEach(() => {
  global.fetch = realFetch;
});

function make429(retryAfter) {
  return {
    ok: false,
    status: 429,
    headers: { get: h => (h === 'Retry-After' && retryAfter !== undefined) ? String(retryAfter) : null },
    text: async () => 'rate limited',
  };
}
function make200(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('notionFetch retries a 429 and succeeds once the rate limit clears', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls <= 2 ? make429(0) : make200({ ok: true });
  };
  const result = await notionFetch('x');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test('notionFetch honors a "Retry-After: 0" header literally, not as a falsy fallback', async () => {
  // Number(null) is 0, indistinguishable via `||` from a genuine "0" header
  // — this guards against that specific coercion bug.
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? make429(0) : make200({ ok: true });
  };
  const start = Date.now();
  await notionFetch('x');
  assert.ok(Date.now() - start < 500, 'should not have waited a full backoff second for Retry-After: 0');
});

test('notionFetch falls back to exponential backoff when Retry-After is absent', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? make429(undefined) : make200({ ok: true });
  };
  const start = Date.now();
  await notionFetch('x');
  assert.ok(Date.now() - start >= 900, 'first retry should back off ~1s (2^0)');
});

test('notionFetch gives up and throws after exhausting retries', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return make429(0); };
  await assert.rejects(() => notionFetch('x'), /Notion API 429/);
  assert.equal(calls, 4); // initial attempt + 3 retries
});

test('notionFetch does not retry non-429 errors', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'server error' };
  };
  await assert.rejects(() => notionFetch('x'), /Notion API 500/);
  assert.equal(calls, 1);
});
