const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createChromeMock } = require('../test-support/chromeMock');
const { freshRequire, EXT_DIR } = require('../test-support/loadExtensionModule');

// popup.js is loaded via a plain <script> tag in the real popup, after
// shared.js's own <script> tag — mirror that ordering by merging shared.js's
// exports onto the global scope before requiring popup.js, and provide a
// real DOM via jsdom (popup.js manipulates document.getElementById directly).
function loadPopup(chromeOverrides, { url = 'https://example.com/' } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.chrome = createChromeMock(chromeOverrides);
  Object.assign(global, require(path.join(EXT_DIR, 'shared.js')));
  return freshRequire('popup.js');
}

let realFetch;
beforeEach(() => {
  delete global.window;
  delete global.document;
  delete global.location;
  delete global.chrome;
  realFetch = global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

// ---- Pure HTML-string helpers (no DOM needed) ----

test('stageBadge renders the stage name with its canonical color', () => {
  const popup = loadPopup();
  assert.equal(
    popup.stageBadge('Applied'),
    '<span class="stage-badge" style="background:#dbeafe;color:#1d4ed8">Applied</span>',
  );
});

test('stageBadge falls back to a neutral color for an unrecognized stage', () => {
  const popup = loadPopup();
  assert.match(popup.stageBadge('SomeNewStage'), /background:#f3f4f6;color:#6b7280/);
});

test('otherAppsAtCompany: matches by company case-insensitively, excludes the current URL', () => {
  const popup = loadPopup();
  const entries = [
    { company: 'Acme', url: 'https://example.com/job/1', role: 'PM', stage: 'Applied' },
    { company: 'acme', url: 'https://example.com/job/2', role: 'Eng', stage: 'Interviews' },
    { company: 'Northwind', url: 'https://example.com/job/3', role: 'PM', stage: 'Applied' },
  ];
  const result = popup.otherAppsAtCompany(entries, 'Acme', 'https://example.com/job/1');
  assert.deepEqual(result.map(e => e.url), ['https://example.com/job/2']);
});

test('otherAppsAtCompany returns [] when company is empty', () => {
  const popup = loadPopup();
  assert.deepEqual(popup.otherAppsAtCompany([{ company: 'Acme', url: 'x' }], '', 'y'), []);
});

test('otherAppsAtCompany: matches loosely (substring), not just exact equality', () => {
  // Regression: background.js's own "other applications at this company"
  // toolbar badge already used a loose match — a company whose detected
  // name carries extra noise (e.g. a verbose JSON-LD legal name) exact-
  // matched against nothing, so the badge showed but the popup's own
  // "Also at X" box silently didn't, even though both were asking the same
  // question about the same tracked entries.
  const entries = [
    { company: 'Acme Manufacturing A/S', url: 'https://example.com/job/2', role: 'Eng', stage: 'Interviews' },
  ];
  const popup = loadPopup();
  const result = popup.otherAppsAtCompany(entries, 'Acme', 'https://example.com/job/1');
  assert.deepEqual(result.map(e => e.url), ['https://example.com/job/2']);
});

test('otherAppsHtml renders up to OTHER_APPS_MAX entries and a "+N more" tail', () => {
  const popup = loadPopup();
  const many = Array.from({ length: 6 }, (_, i) => ({ role: `Role ${i}`, stage: 'Applied' }));
  const html = popup.otherAppsHtml('Acme', many);
  assert.match(html, /Also at Acme/);
  assert.equal((html.match(/other-apps-item/g) || []).length, 4); // OTHER_APPS_MAX
  assert.match(html, /\+2 more/);
});

test('otherAppsHtml returns an empty string when there are no other entries', () => {
  const popup = loadPopup();
  assert.equal(popup.otherAppsHtml('Acme', []), '');
});

// ---- renderTracked (real DOM via jsdom) ----

test('renderTracked shows company, role, stage badge, and the "Also at X" box', () => {
  const popup = loadPopup();
  const entry = { company: 'Acme', role: 'Product Manager', stage: 'Applied', url: 'https://example.com/job/1', lastUpdate: null };
  const entries = [entry, { company: 'Acme', role: 'Engineer', stage: 'Interviews', url: 'https://example.com/job/2' }];

  popup.renderTracked(entry, entries);

  const root = global.document.getElementById('root');
  assert.match(root.querySelector('.company').textContent, /Acme/);
  assert.match(root.querySelector('.role').textContent, /Product Manager/);
  assert.ok(root.querySelector('.other-apps'));
  assert.ok(global.document.getElementById('open-tracker'));
  assert.ok(global.document.getElementById('refresh-btn'));
});

test('renderTracked omits the Notion button when there\'s no notionPageId', () => {
  const popup = loadPopup();
  popup.renderTracked({ company: 'Acme', stage: 'Applied', url: 'https://example.com/job/1' }, []);
  assert.equal(global.document.getElementById('open-notion'), null);
});

test('renderTracked shows the Notion button when a notionPageId is present', () => {
  const popup = loadPopup();
  popup.renderTracked({ company: 'Acme', stage: 'Applied', url: 'https://example.com/job/1', notionPageId: 'abc123' }, []);
  assert.ok(global.document.getElementById('open-notion'));
});

// ---- renderSaveForm (real DOM via jsdom) ----

test('renderSaveForm pre-fills the Role/Company fields from the detected info', () => {
  const popup = loadPopup();
  popup.renderSaveForm('https://example.com/job/1', { role: 'Product Manager', company: 'Acme' }, []);
  assert.equal(global.document.getElementById('inp-role').value, 'Product Manager');
  assert.equal(global.document.getElementById('inp-company').value, 'Acme');
});

test('renderSaveForm updates the "Also at X" box live as the Company field is edited', () => {
  const popup = loadPopup();
  const entries = [{ company: 'Northwind', url: 'https://example.com/job/2', role: 'PM', stage: 'Applied' }];
  popup.renderSaveForm('https://example.com/job/1', { role: 'PM', company: '' }, entries);

  const container = global.document.getElementById('other-apps-container');
  assert.equal(container.innerHTML.trim(), ''); // no company yet -> nothing shown

  const companyInput = global.document.getElementById('inp-company');
  companyInput.value = 'Northwind';
  companyInput.dispatchEvent(new global.window.Event('input'));

  assert.match(container.innerHTML, /Also at Northwind/);
});

test('renderSaveForm: saving with an empty Company shows a validation error, not a network call', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  const popup = loadPopup({ activeTab: { id: 1, url: 'https://example.com/job/1', title: 'x' } });
  popup.renderSaveForm('https://example.com/job/1', { role: 'PM', company: '' }, []);

  global.document.getElementById('inp-company').value = '';
  global.document.getElementById('save-btn').dispatchEvent(new global.window.Event('click'));
  await Promise.resolve(); await Promise.resolve();

  assert.equal(fetchCalled, false);
  assert.match(global.document.getElementById('save-status').textContent, /Company is required/);
});

test('renderSaveForm: successful save posts to /api/tracker/save and shows "Saved!"', async () => {
  const posted = [];
  global.fetch = async (url, opts) => {
    if (url.includes('/api/tracker/save')) { posted.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/job/1', title: 'x' },
    executeScript: async () => [{ result: null }], // no injected content on this fake page
  });
  popup.renderSaveForm('https://example.com/job/1', { role: 'Product Manager', company: 'Acme' }, []);

  global.document.getElementById('save-btn').dispatchEvent(new global.window.Event('click'));
  // Two real async hops: the executeScript call, then the save POST.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].company, 'Acme');
  assert.equal(posted[0].role, 'Product Manager');
  assert.match(global.document.getElementById('save-status').textContent, /Saved!/);
});

test('renderSaveForm: a failed save shows the server\'s error and re-enables the button', async () => {
  global.fetch = async (url) => {
    if (url.includes('/api/tracker/save')) return { ok: false, statusText: 'err', json: async () => ({ error: 'Notion API 429: rate_limited' }) };
    return { ok: true, json: async () => ({}) };
  };
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/job/1', title: 'x' },
    executeScript: async () => [{ result: null }],
  });
  popup.renderSaveForm('https://example.com/job/1', { role: 'PM', company: 'Acme' }, []);

  const btn = global.document.getElementById('save-btn');
  btn.dispatchEvent(new global.window.Event('click'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.match(global.document.getElementById('save-status').textContent, /rate_limited/);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Save to Notion');
});

// ---- init() (three branches: not-a-job-page / tracked / untracked) ----

test('init: shows "Not a job page" when the active tab has no http(s) URL', async () => {
  const popup = loadPopup({ activeTab: { id: 1, url: 'chrome://newtab', title: 'New Tab' } });
  await popup.init();
  assert.match(global.document.getElementById('root').textContent, /Not a job page/);
});

test('init: shows "Not a job page" when there is no active tab at all', async () => {
  const popup = loadPopup({ tabsQuery: () => Promise.resolve([]) });
  await popup.init();
  assert.match(global.document.getElementById('root').textContent, /Not a job page/);
});

test('init: renders renderTracked when the tab URL matches a stored entry', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/job/1', title: 'irrelevant' },
    storageData: { urlEntries: [{ url: 'https://example.com/job/1', company: 'Acme', role: 'PM', stage: 'Applied' }] },
  });
  await popup.init();
  assert.match(global.document.getElementById('root').querySelector('.company').textContent, /Acme/);
  assert.ok(global.document.getElementById('open-tracker'));
});

test('init: renders renderSaveForm from the title-derived guess when the tab is untracked and has no JSON-LD', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://jobs.lever.co/acme/xyz', title: 'Product Manager - Acme' },
    executeScript: async () => [{ result: null }], // no JobPosting/Organization JSON-LD on this page
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme');
  assert.ok(global.document.getElementById('save-btn'));
});

test('init: prefers JobPosting JSON-LD role+company over the title-derived guess', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://jobs.lever.co/acme/xyz', title: 'Some Misleading Title' },
    executeScript: async () => [{ result: { role: 'staff engineer', company: 'Acme Corp' } }],
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme Corp');
  assert.equal(global.document.getElementById('inp-role').value, 'Staff Engineer');
});

test('init: an Organization-only JSON-LD fills in just the company, keeping the title-derived role', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/careers/some-role', title: 'Some Role - Not Acme' },
    executeScript: async () => [{ result: { company: 'Acme (Org Node)' } }],
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme (Org Node)');
  assert.notEqual(global.document.getElementById('inp-role').value, '');
});

test('init: strips a leading numeric reference code from a JobPosting JSON-LD company name', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://jobs.lever.co/acme/xyz', title: 'Some Misleading Title' },
    executeScript: async () => [{ result: { role: 'staff engineer', company: '4521 Acme Manufacturing A/S' } }],
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme Manufacturing A/S');
});

test('init: strips a leading numeric reference code from an Organization-only JSON-LD company name too', async () => {
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/careers/some-role', title: 'Some Role - Not Acme' },
    executeScript: async () => [{ result: { company: '4521 Acme Manufacturing A/S' } }],
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme Manufacturing A/S');
});

test('init: an Organization-only JSON-LD company overrides a wrong (not just missing) title-derived guess', async () => {
  // Regression: a real reported posting's tab title was a 3-segment
  // breadcrumb ("Careers | Job Openings | Acme") — the title parser's naive
  // first-pipe split produced a non-empty but wrong company ("Job Openings |
  // Acme"), which used to block the page's own (correct) Organization
  // JSON-LD name from ever overriding it, since the fallback only filled in
  // a *missing* company, not a wrong one.
  const popup = loadPopup({
    activeTab: { id: 1, url: 'https://example.com/careers/', title: 'Careers | Job Openings | Acme' },
    executeScript: async () => [{ result: { company: 'Acme' } }],
  });
  await popup.init();
  assert.equal(global.document.getElementById('inp-company').value, 'Acme');
});
