// Integration tests for the file-writing Q&A routes, focused on the
// path-traversal guards (the security-relevant logic). The app is pointed at a
// throwaway data directory via env so nothing touches real files.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring the app (config reads these at load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-routes-'));
process.env.JOBTRACKER_DATA_DIR = tmp;
process.env.JOBTRACKER_ORDER_FILE = path.join(tmp, 'order.json');
process.env.JOBTRACKER_CONFIG_FILE = path.join(tmp, 'config.json');
fs.writeFileSync(path.join(tmp, 'acme.txt'), 'What is your strength?\n\nI ship things.\n');

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

const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (p) => (await fetch(base + p)).json();

test('add-general rejects a non-.txt source', async () => {
  const r = await post('/api/add-general', { answer: 'x', source: 'evil.exe' });
  assert.equal(r.status, 400);
});

test('add-general neutralises ../ traversal via basename (write stays inside the data dir)', async () => {
  const r = await post('/api/add-general', { answer: 'a'.repeat(60), source: '../escape.txt' });
  assert.equal(r.status, 200);
  // basename('../escape.txt') === 'escape.txt' → written inside the data dir...
  assert.ok(fs.existsSync(path.join(tmp, 'escape.txt')));
  // ...and nothing leaked to the parent directory
  assert.ok(!fs.existsSync(path.join(tmp, '..', 'escape.txt')));
});

test('update rejects an absolute path outside the data dir', async () => {
  const r = await post('/api/update', { filePath: '/etc/passwd', id: 'x', question: 'q', answer: 'a' });
  assert.equal(r.status, 400);
  // Assert the guard's specific message, not just the status — otherwise a path
  // that happens to read but has no matching id also returns 400 ("Pair not
  // found"), and the test would pass even with the guard removed.
  assert.equal((await r.json()).error, 'Invalid file path');
});

test('update rejects a ../ path that escapes the data dir', async () => {
  const escaping = path.join(tmp, '..', 'outside.txt');
  const r = await post('/api/update', { filePath: escaping, id: 'x', question: 'q', answer: 'a' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'Invalid file path');
  assert.ok(!fs.existsSync(path.join(tmp, '..', 'outside.txt')));
});

test('move-entry cannot escape the data dir (basename-contained → 404 for missing file)', async () => {
  const r = await post('/api/move-entry', { fromFile: '../../etc/passwd', toFile: 'acme.txt', id: 'x' });
  assert.equal(r.status, 404);
});

test('rename-company rejects a non-.txt oldFile', async () => {
  const r = await post('/api/rename-company', { oldFile: 'acme.exe', newName: 'Acme' });
  assert.equal(r.status, 400);
});

test('add-general happy path: new entry shows up in /api/data', async () => {
  const r = await post('/api/add-general', { question: 'New question?', answer: 'A fresh answer body.', source: 'acme.txt' });
  assert.equal(r.status, 200);
  const { newId } = await r.json();
  assert.match(newId, /^[0-9a-f]{12}$/);
  const data = await getJson('/api/data');
  assert.ok(data.pairs.some(p => p.id === newId));
});
