// lib/config.js and lib/store.js both read their env-var overrides once, at
// require() time (JOBTRACKER_DATA_DIR/ORDER_FILE/CONFIG_FILE), into
// module-level consts — so each test needing its own throwaway directory
// needs a fresh require() of both, not just a fresh env var. Same underlying
// technique as test-support/loadExtensionModule.js's freshRequire, applied
// here to plain Node modules instead of the extension.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-store-'));
  process.env.JOBTRACKER_DATA_DIR = tmp;
  process.env.JOBTRACKER_ORDER_FILE = path.join(tmp, 'order.json');
  process.env.JOBTRACKER_CONFIG_FILE = path.join(tmp, 'config.json');
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/store')];
  store = require('../lib/store');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.JOBTRACKER_DATA_DIR;
  delete process.env.JOBTRACKER_ORDER_FILE;
  delete process.env.JOBTRACKER_CONFIG_FILE;
});

// ---- loadConfig ----

test('loadConfig: falls back to DEFAULT_CONFIG when no config file exists', () => {
  const config = store.loadConfig();
  assert.deepEqual(config.categories, store.DEFAULT_CONFIG.categories);
  assert.deepEqual(config.companyNames, {});
});

test('loadConfig: falls back to DEFAULT_CONFIG on malformed JSON instead of throwing', () => {
  fs.writeFileSync(path.join(tmp, 'config.json'), '{ not valid json');
  const config = store.loadConfig();
  assert.deepEqual(config.categories, store.DEFAULT_CONFIG.categories);
});

test('loadConfig: a saved config overrides categories/rules wholesale', () => {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    categories: ['Custom A', 'Custom B'],
    rules: [{ cat: 'Custom A', keywords: ['widget'] }],
  }));
  const config = store.loadConfig();
  assert.deepEqual(config.categories, ['Custom A', 'Custom B']);
  assert.deepEqual(config.rules, [{ cat: 'Custom A', keywords: ['widget'] }]);
});

test('loadConfig: preserves saved companyNames instead of erasing them (regression: PR #2)', () => {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    categories: store.DEFAULT_CONFIG.categories,
    companyNames: { 'acme-corp.txt': 'Acme Corp' },
  }));
  const config = store.loadConfig();
  assert.deepEqual(config.companyNames, { 'acme-corp.txt': 'Acme Corp' });
});

test('loadConfig: mutating a returned config\'s companyNames never leaks into DEFAULT_CONFIG', () => {
  // DEFAULT_CONFIG.companyNames is always {} in this codebase, so the
  // interesting case isn't merging two non-empty objects — it's that the
  // spread-copy actually protects the shared DEFAULT_CONFIG object from a
  // caller mutating what loadConfig() handed back.
  const first = store.loadConfig();
  first.companyNames.injected = 'should not leak';
  const second = store.loadConfig();
  assert.equal(second.companyNames.injected, undefined);
  assert.equal(store.DEFAULT_CONFIG.companyNames.injected, undefined);
});

// ---- saveConfig ----

test('saveConfig -> loadConfig round-trips', () => {
  const toSave = { ...store.DEFAULT_CONFIG, categories: ['Only Category'] };
  store.saveConfig(toSave);
  assert.deepEqual(store.loadConfig().categories, ['Only Category']);
});

// ---- loadOrder ----

test('loadOrder: returns an empty null-prototype object when no order file exists', () => {
  const order = store.loadOrder();
  assert.deepEqual(Object.keys(order), []);
  assert.equal(Object.getPrototypeOf(order), null);
});

test('loadOrder: falls back to an empty null-prototype object on malformed JSON', () => {
  fs.writeFileSync(path.join(tmp, 'order.json'), 'not json');
  const order = store.loadOrder();
  assert.deepEqual(Object.keys(order), []);
  assert.equal(Object.getPrototypeOf(order), null);
});

test('loadOrder: a "__proto__" key in the saved file cannot pollute Object.prototype', () => {
  // Object.create(null) means assigning a literal "__proto__" key sets a
  // normal own property, not the object's actual prototype — this is the
  // guard the comment in store.js calls out explicitly.
  fs.writeFileSync(path.join(tmp, 'order.json'), JSON.stringify({
    '__proto__': { polluted: true },
    'abc123456789': { category: 'Other', sortIndex: 0 },
  }));
  const order = store.loadOrder();
  assert.equal(({}).polluted, undefined);
  assert.equal(order.abc123456789.category, 'Other');
});

// ---- saveOrder ----

test('saveOrder -> loadOrder round-trips', () => {
  store.saveOrder({ id1: { category: 'Other', sortIndex: 0 } });
  const order = store.loadOrder();
  assert.deepEqual(order.id1, { category: 'Other', sortIndex: 0 });
});

// ---- getAll ----

function writeQA(file, text) {
  fs.writeFileSync(path.join(tmp, file), text);
}

test('getAll: parses every .txt file in the data dir and attaches source/filePath', () => {
  writeQA('acme-corp.txt', 'Why this company?\n\nBecause it is a great fit for my skills and interests.');
  const { pairs } = store.getAll();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].source, 'Acme Corp');
  assert.equal(pairs[0].filePath, path.join(tmp, 'acme-corp.txt'));
  assert.equal(pairs[0].question, 'Why this company?');
});

test('getAll: answers.txt gets the special "My Answers" display name', () => {
  writeQA('answers.txt', 'General strength?\n\nI ship things reliably and communicate clearly with my team.');
  const { pairs } = store.getAll();
  assert.equal(pairs[0].source, 'My Answers');
});

test('getAll: a saved companyNames override wins over the derived file label', () => {
  writeQA('acme-corp.txt', 'Why this company?\n\nBecause it is a great fit for my skills and interests.');
  store.saveConfig({ ...store.DEFAULT_CONFIG, companyNames: { 'acme-corp.txt': 'ACME (custom)' } });
  const { pairs } = store.getAll();
  assert.equal(pairs[0].source, 'ACME (custom)');
});

test('getAll: drops a question-less block whose answer is too short to be meaningful', () => {
  // Mirrors the filter in getAll(): `p.question || p.answer.length > 50`.
  writeQA('acme-corp.txt', 'Too short.');
  const { pairs } = store.getAll();
  assert.equal(pairs.length, 0);
});

test('getAll: keeps a question-less block when the answer is long enough', () => {
  writeQA('acme-corp.txt', 'A'.repeat(60));
  const { pairs } = store.getAll();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, null);
});

test('getAll: auto-categorizes using config.rules when there is no saved order entry', () => {
  writeQA('acme-corp.txt', 'How do you use AI tools in your workflow?\n\nI use them daily for drafting and review.');
  const { pairs } = store.getAll();
  assert.equal(pairs[0].category, 'AI & Tools');
});

test('getAll: a saved order entry\'s category overrides auto-categorization', () => {
  writeQA('acme-corp.txt', 'How do you use AI tools in your workflow?\n\nI use them daily for drafting and review.');
  const { pairs: firstPass } = store.getAll();
  const id = firstPass[0].id;
  store.saveOrder({ [id]: { category: 'Culture & Team Fit', sortIndex: 3 } });
  const { pairs } = store.getAll();
  assert.equal(pairs[0].category, 'Culture & Team Fit');
  assert.equal(pairs[0].sortIndex, 3);
});

test('getAll: sorts pairs by category order (per config.categories), then sortIndex within category', () => {
  writeQA('acme-corp.txt',
    'Q1?\n\nFirst answer padded out to be long enough to count as a real one.' +
    '\n\n\n\nQ2?\n\nSecond answer padded out to be long enough to count as a real one.',
  );
  const { pairs: firstPass } = store.getAll();
  // Force both into the same category, with Q2 (index 1) ordered before Q1 (index 0).
  store.saveOrder({
    [firstPass[0].id]: { category: 'Other', sortIndex: 1 },
    [firstPass[1].id]: { category: 'Other', sortIndex: 0 },
  });
  const { pairs } = store.getAll();
  assert.equal(pairs[0].question, 'Q2?');
  assert.equal(pairs[1].question, 'Q1?');
});

test('getAll: returns config.categories alongside pairs', () => {
  const { categories } = store.getAll();
  assert.deepEqual(categories, store.DEFAULT_CONFIG.categories);
});
