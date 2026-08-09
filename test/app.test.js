const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, freshRequire, flush } = require('../test-support/loadPage');

const CATEGORIES = ['Product Process', 'Technical Skills', 'Other'];
const COMPANIES = [
  { file: 'answers.txt', name: 'My Answers' },
  { file: 'acme-corp.txt', name: 'Acme Corp' },
];

function pair(over = {}) {
  return {
    id: 'id1', question: 'Why this role?', answer: 'Because it fits my skills.',
    category: 'Product Process', source: 'Acme Corp', filePath: '/data/acme-corp.txt',
    sortIndex: 0, ...over,
  };
}

function jsonRes(body, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => body }; }

// GET /api/data and /api/companies are always served from `pairs`/`companies`
// (app.js's init fetches both unconditionally on load) — `extra` lets a test
// intercept specific POST endpoints without re-implementing the whole router.
function makeFetch({ pairs = [pair()], categories = CATEGORIES, companies = COMPANIES, extra } = {}) {
  return async (url, opts) => {
    const method = opts?.method || 'GET';
    if (extra) {
      const handled = await extra(url, opts, method);
      if (handled) return handled;
    }
    if (method === 'GET' && url.startsWith('/api/data')) return jsonRes({ pairs, categories });
    if (method === 'GET' && url.startsWith('/api/companies')) return jsonRes(companies);
    return jsonRes({});
  };
}

let realFetch;
beforeEach(() => { realFetch = global.fetch; });
afterEach(() => {
  global.fetch = realFetch;
  delete global.window; delete global.document; delete global.location;
  delete global.CSS; delete global.requestAnimationFrame; delete global.Sortable;
});

async function setup(opts) {
  await loadPage({ fetchMock: makeFetch(opts) });
  const app = freshRequire('public/app.js');
  await flush();
  return app;
}

// ---- Pure helpers ----

test('esc escapes HTML-significant characters', async () => {
  const app = await setup();
  assert.equal(app.esc(`<script>&"'`), '&lt;script&gt;&amp;&quot;\'');
});

test('highlight wraps matches in <mark>, case-insensitively', async () => {
  const app = await setup();
  assert.equal(app.highlight('Product Manager', 'manager'), 'Product <mark>Manager</mark>');
});

test('highlight treats regex-special characters in the query as literal, not as regex syntax', async () => {
  const app = await setup();
  // Unescaped, "." would match any character (so "acb" would wrongly match
  // too) — escaped, it only matches a literal ".".
  const result = app.highlight('Version a.b.1 and version acb differ', 'a.b');
  assert.match(result, /<mark>a\.b<\/mark>\.1/);
  assert.doesNotMatch(result, /<mark>acb<\/mark>/);
});

test('highlight returns escaped text unchanged when there is no query', async () => {
  const app = await setup();
  assert.equal(app.highlight('<b>x</b>', ''), '&lt;b&gt;x&lt;/b&gt;');
});

test('countLabel: singular vs plural word/char counts, empty string returns nothing', async () => {
  const app = await setup();
  assert.equal(app.countLabel('hi'), '1 word · 2 chars');
  assert.equal(app.countLabel('hi there'), '2 words · 8 chars');
  assert.equal(app.countLabel('   '), '');
  assert.equal(app.countLabel(''), '');
});

// ---- Init -> render -> renderSidebar pipeline ----

test('init: renders a card per pair, grouped under its category, and populates the sidebar', async () => {
  await setup({ pairs: [pair()] });
  const main = global.document.getElementById('main');
  assert.match(main.innerHTML, /Why this role\?/);
  assert.match(main.innerHTML, /Because it fits my skills\./);
  assert.match(main.querySelector('.cat-section').outerHTML, /Product Process/);

  const sidebar = global.document.getElementById('sidebar');
  assert.match(sidebar.innerHTML, /Acme Corp/);
});

test('init: a null-question pair renders as "General response"', async () => {
  await setup({ pairs: [pair({ id: 'id2', question: null })] });
  assert.match(global.document.getElementById('main').innerHTML, /General response/);
});

test('render: an empty pair list shows "No results."', async () => {
  await setup({ pairs: [] });
  assert.match(global.document.getElementById('main').innerHTML, /No results\./);
});

// ---- Search ----

test('search: typing into #search filters visible pairs and highlights the match', async () => {
  await setup({ pairs: [
    pair({ id: 'id1', question: 'Why this role?', answer: 'Skills.' }),
    pair({ id: 'id2', question: 'Tell me about yourself', answer: 'Background.' }),
  ] });
  const searchInput = global.document.getElementById('search');
  searchInput.value = 'yourself';
  searchInput.dispatchEvent(new global.window.Event('input'));

  const main = global.document.getElementById('main');
  assert.doesNotMatch(main.innerHTML, /Why this role/);
  assert.match(main.innerHTML, /<mark>yourself<\/mark>/i);
});

// ---- Company filter (sidebar) ----

test('clicking a company in the sidebar filters the main view to that company only', async () => {
  await setup({ pairs: [
    pair({ id: 'id1', source: 'Acme Corp' }),
    pair({ id: 'id2', source: 'My Answers', question: 'General strength?', answer: 'I adapt quickly.' }),
  ] });
  const companyItem = [...global.document.querySelectorAll('.nav-company')]
    .find(el => el.dataset.company === 'Acme Corp');
  companyItem.dispatchEvent(new global.window.Event('click', { bubbles: true }));

  const main = global.document.getElementById('main');
  assert.match(main.innerHTML, /Why this role/);
  assert.doesNotMatch(main.innerHTML, /General strength/);
});

// ---- Add panel ----

test('add panel: an empty answer shows a validation toast and never calls the save endpoint', async () => {
  let saveCalled = false;
  const app = await setup({ extra: async (url) => {
    if (url.startsWith('/api/add-general')) { saveCalled = true; return jsonRes({ newId: 'x' }); }
  } });
  global.document.getElementById('new-answer').value = '';
  global.document.getElementById('add-save').dispatchEvent(new global.window.Event('click'));
  await flush();

  assert.equal(saveCalled, false);
  assert.match(global.document.getElementById('toast').textContent, /Answer is required/);
});

test('add panel: a successful save posts to /api/add-general and refreshes the list', async () => {
  let posted = null;
  await setup({ extra: async (url, opts) => {
    if (url.startsWith('/api/add-general')) { posted = JSON.parse(opts.body); return jsonRes({ newId: 'newid123' }); }
    if (url.startsWith('/api/data')) return jsonRes({ pairs: [pair({ id: 'newid123', question: 'New Q?', answer: 'New A, long enough to render.' })], categories: CATEGORIES });
  } });

  global.document.getElementById('new-answer').value = 'A fresh answer.';
  global.document.getElementById('new-question').value = 'A fresh question?';
  global.document.getElementById('add-save').dispatchEvent(new global.window.Event('click'));
  await flush();

  assert.equal(posted.answer, 'A fresh answer.');
  assert.equal(posted.question, 'A fresh question?');
  assert.match(global.document.getElementById('main').innerHTML, /New Q\?/);
});

// ---- Edit mode ----

test('edit mode: clicking the edit button shows a pre-filled textarea, and Save posts to /api/update', async () => {
  let posted = null;
  await setup({
    pairs: [pair({ id: 'id1', question: 'Why this role?', answer: 'Because it fits my skills.' })],
    extra: async (url, opts) => {
      if (url.startsWith('/api/update')) { posted = JSON.parse(opts.body); return jsonRes({ newId: 'id1-updated' }); }
    },
  });

  global.document.querySelector('.edit-btn').dispatchEvent(new global.window.Event('click', { bubbles: true }));
  const textarea = global.document.querySelector('.edit-a');
  assert.equal(textarea.value, 'Because it fits my skills.');

  textarea.value = 'An updated answer.';
  global.document.querySelector('.save-btn').dispatchEvent(new global.window.Event('click'));
  await flush();

  assert.equal(posted.answer, 'An updated answer.');
  assert.equal(posted.id, 'id1');
});

// ---- Move entry (per-card company select) ----

test('changing a card\'s company select posts to /api/move-entry and updates the card\'s source', async () => {
  let posted = null;
  await setup({
    pairs: [pair({ id: 'id1', source: 'Acme Corp', filePath: '/data/acme-corp.txt' })],
    extra: async (url, opts) => {
      if (url.startsWith('/api/move-entry')) { posted = JSON.parse(opts.body); return jsonRes({ ok: true }); }
    },
  });

  const select = global.document.querySelector('.card-source-select');
  select.value = 'answers.txt';
  select.dispatchEvent(new global.window.Event('change'));
  await flush();

  assert.equal(posted.fromFile, 'acme-corp.txt');
  assert.equal(posted.toFile, 'answers.txt');
  assert.equal(posted.id, 'id1');
});

// ---- Settings: company rename ----

test('renaming a company in Settings posts to /api/rename-company and updates in-memory state', async () => {
  let posted = null;
  const app = await setup({
    pairs: [pair({ id: 'id1', source: 'Acme Corp' })],
    extra: async (url, opts) => {
      if (url.startsWith('/api/config')) return jsonRes({ categories: CATEGORIES, companyNames: {}, rules: [] });
      if (url.startsWith('/api/rename-company')) {
        posted = JSON.parse(opts.body);
        return jsonRes({ file: 'acme-renamed.txt', name: 'Acme Renamed' });
      }
    },
  });

  await app.openSettings();
  const input = global.document.querySelector('.company-name-input[data-file="acme-corp.txt"]');
  input.value = 'Acme Renamed';
  input.dispatchEvent(new global.window.Event('blur'));
  await flush();

  assert.equal(posted.oldFile, 'acme-corp.txt');
  assert.equal(posted.newName, 'Acme Renamed');
  assert.match(global.document.getElementById('main').innerHTML, /Acme Renamed/);
});
