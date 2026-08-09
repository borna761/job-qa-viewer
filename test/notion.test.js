const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { notionFetch, parseTitleToApp } = require('../lib/notion');

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

// ---- parseTitleToApp ----
// Notion child-page title format (documented in the README):
// "[🔗 link] — Role | Company"

function block(title, { id = 'page-id', created_time = '2026-01-01T00:00:00.000Z' } = {}) {
  return { id, created_time, child_page: { title } };
}

test('parseTitleToApp: full "[link] — Role | Company" title splits role and company', () => {
  assert.deepEqual(
    parseTitleToApp(block('[🔗 link] — Product Manager | Acme Corp'), 'Applied'),
    { company: 'Acme Corp', role: 'Product Manager', stage: 'Applied', lastUpdate: '2026-01-01T00:00:00.000Z', source: 'notion', notionPageId: 'page-id' },
  );
});

test('parseTitleToApp: the "[link] —" prefix is optional — a bare "Role | Company" still splits', () => {
  assert.deepEqual(
    parseTitleToApp(block('Product Manager | Acme Corp'), 'Applied'),
    { company: 'Acme Corp', role: 'Product Manager', stage: 'Applied', lastUpdate: '2026-01-01T00:00:00.000Z', source: 'notion', notionPageId: 'page-id' },
  );
});

test('parseTitleToApp: an en-dash or plain hyphen after the bracket works the same as an em-dash', () => {
  assert.equal(parseTitleToApp(block('[🔗 link] – Product Manager | Acme Corp'), 'Applied').role, 'Product Manager');
  assert.equal(parseTitleToApp(block('[🔗 link] - Product Manager | Acme Corp'), 'Applied').role, 'Product Manager');
});

test('parseTitleToApp: strips a leading "Application for" / "Job Application for" from the role', () => {
  assert.equal(parseTitleToApp(block('Application for Product Manager | Acme Corp'), 'Applied').role, 'Product Manager');
  assert.equal(parseTitleToApp(block('Job Application for Product Manager | Acme Corp'), 'Applied').role, 'Product Manager');
});

test('parseTitleToApp: a role that strips down to nothing (e.g. bare "Job Application") becomes null, not an empty string', () => {
  const app = parseTitleToApp(block('Job Application | Acme Corp'), 'Applied');
  assert.equal(app.role, null);
  assert.equal(app.company, 'Acme Corp');
});

test('parseTitleToApp: no pipe at all falls back to the whole (trimmed) title as company, role null', () => {
  assert.deepEqual(
    parseTitleToApp(block('[🔗 link] — Acme Corp'), 'Interviews'),
    { company: 'Acme Corp', role: null, stage: 'Interviews', lastUpdate: '2026-01-01T00:00:00.000Z', source: 'notion', notionPageId: 'page-id' },
  );
});

test('parseTitleToApp: an empty/whitespace-only title (no pipe, nothing left after trimming) returns null', () => {
  assert.equal(parseTitleToApp(block(''), 'Applied'), null);
  assert.equal(parseTitleToApp(block('   '), 'Applied'), null);
});

test('parseTitleToApp: a missing child_page.title is treated as an empty title, not a throw', () => {
  assert.equal(parseTitleToApp({ id: 'x', created_time: null }, 'Applied'), null);
});

test('parseTitleToApp: a missing created_time yields lastUpdate: null', () => {
  const app = parseTitleToApp(block('Role | Company', { created_time: null }), 'Applied');
  assert.equal(app.lastUpdate, null);
});

test('parseTitleToApp: extra whitespace around the pipe is trimmed from both role and company', () => {
  const app = parseTitleToApp(block('  Product Manager   |   Acme Corp  '), 'Applied');
  assert.equal(app.role, 'Product Manager');
  assert.equal(app.company, 'Acme Corp');
});
