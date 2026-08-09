const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, freshRequire, flush } = require('../test-support/loadPage');

function jsonRes(body, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => body }; }

function app(over = {}) {
  return { company: 'Acme', role: 'Product Manager', stage: 'Applied', lastUpdate: '2026-01-05', ...over };
}

let realFetch;
beforeEach(() => { realFetch = global.fetch; });
afterEach(() => {
  global.fetch = realFetch;
  delete global.window; delete global.document; delete global.location;
  delete global.CSS; delete global.requestAnimationFrame; delete global.Sortable;
});

// tracker.js calls esc() as a bare reference, relying on app.js's <script>
// tag having already declared it as a global — true in the real page (both
// load as classic, non-module scripts sharing window scope), but each
// require() gets its own isolated module scope, so that sharing has to be
// done by hand here, same trick background.js's importScripts mock uses.
//
// Loading app.js also fires its own unconditional init fetch
// (/api/data + /api/companies) — these tests don't care about app.js's own
// rendering, so those two routes always get safe empty defaults regardless
// of what a test's own fetchMock handles, to keep that init from crashing
// on undefined data.
async function setup(fetchMock) {
  const routedFetch = async (url, opts) => {
    if (url.startsWith('/api/data')) return jsonRes({ pairs: [], categories: [] });
    if (url.startsWith('/api/companies')) return jsonRes([]);
    if (fetchMock) return fetchMock(url, opts);
    return jsonRes({});
  };
  await loadPage({ fetchMock: routedFetch });
  const app = freshRequire('public/app.js');
  await flush();
  global.esc = app.esc;
  return freshRequire('public/tracker.js');
}

// ---- Pure helpers ----

test('companyToSlug lowercases, replaces non-alphanumerics with dashes, trims edge dashes', async () => {
  const tracker = await setup();
  assert.equal(tracker.companyToSlug('Acme Corp!'), 'acme-corp');
  assert.equal(tracker.companyToSlug('  Möbius  '), 'm-bius');
});

test('stageBadgeHtml: known stages get their color, unknown stages fall back to neutral', async () => {
  const tracker = await setup();
  assert.match(tracker.stageBadgeHtml('Applied'), /background:#dbeafe;color:#1d4ed8/);
  assert.match(tracker.stageBadgeHtml('SomethingUnknown'), /background:#f3f4f6;color:#6b7280/);
});

test('formatDate: formats a real date, and falls back to an em-dash for null/empty', async () => {
  const tracker = await setup();
  assert.equal(tracker.formatDate(null), '—');
  assert.equal(tracker.formatDate(''), '—');
  assert.match(tracker.formatDate('2026-01-05'), /Jan/);
});

test('gmailErrorMessage: a token/expiry-shaped error gets the re-authorise link, others get a generic message', async () => {
  const tracker = await setup();
  assert.match(tracker.gmailErrorMessage('invalid_grant: Token has been expired or revoked'), /Re-authorise Gmail/);
  assert.match(tracker.gmailErrorMessage('Gmail API 500'), /Gmail error: Gmail API 500/);
});

test('emailCardHtml: labels outgoing vs incoming, and escapes the subject', async () => {
  const tracker = await setup();
  const out = tracker.emailCardHtml({ subject: '<b>hi</b>', from: 'a@b.com', date: 'Jan 1', isOutgoing: true }, 0);
  assert.match(out, /↑ Sent/);
  assert.match(out, /&lt;b&gt;hi&lt;\/b&gt;/);
  const inc = tracker.emailCardHtml({ subject: 'hi', from: 'a@b.com', date: 'Jan 1', isOutgoing: false }, 0);
  assert.match(inc, /↓ Received/);
});

// ---- renderTracker (stats + filters + table) ----

test('renderTracker: stats chips reflect stage counts, and the table renders one row per app', async () => {
  const tracker = await setup();
  tracker.renderTracker([app({ company: 'Acme' }), app({ company: 'Northwind', stage: 'Rejected' })]);
  assert.match(global.document.getElementById('tracker-stats').innerHTML, />2 <span>Total<\/span></);
  const rows = global.document.querySelectorAll('.app-row');
  assert.equal(rows.length, 2);
});

test('renderTable: sorts by most-recent lastUpdate first; null dates sink to the bottom', async () => {
  const tracker = await setup();
  tracker.renderTracker([
    app({ company: 'Older', lastUpdate: '2026-01-01' }),
    app({ company: 'NoDate', lastUpdate: null }),
    app({ company: 'Newest', lastUpdate: '2026-02-01' }),
  ]);
  const names = [...global.document.querySelectorAll('.app-company')].map(el => el.textContent);
  assert.deepEqual(names, ['Newest', 'Older', 'NoDate']);
});

test('renderTable: within the same (missing) date, ties break by stage order then company name', async () => {
  const tracker = await setup();
  tracker.renderTracker([
    app({ company: 'Zeta', stage: 'Applied', lastUpdate: null }),
    app({ company: 'Alpha', stage: 'Interviews', lastUpdate: null }),
    app({ company: 'Beta', stage: 'Applied', lastUpdate: null }),
  ]);
  const names = [...global.document.querySelectorAll('.app-company')].map(el => el.textContent);
  // Interviews (rank 0) before Applied (rank 1); Applied ties break alphabetically.
  assert.deepEqual(names, ['Alpha', 'Beta', 'Zeta']);
});

test('clicking a stage filter button narrows the table to that stage', async () => {
  // Goes through loadTracker() rather than calling renderTracker() directly
  // — the filter button's own click handler re-renders from the module-level
  // appsCache, which only loadTracker() ever populates.
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/load')) {
      return jsonRes({
        applications: [
          app({ company: 'Acme', stage: 'Applied' }),
          app({ company: 'Northwind', stage: 'Rejected' }),
        ],
        setup: {},
      });
    }
  });
  await tracker.loadTracker(false);

  const rejectedBtn = [...global.document.querySelectorAll('.filter-btn')].find(b => b.dataset.stage === 'Rejected');
  rejectedBtn.dispatchEvent(new global.window.Event('click'));

  const names = [...global.document.querySelectorAll('.app-company')].map(el => el.textContent);
  assert.deepEqual(names, ['Northwind']);
});

test('renderTracker: an empty app list shows the "no applications match" message', async () => {
  const tracker = await setup();
  tracker.renderTracker([]);
  assert.match(global.document.getElementById('tracker-content').innerHTML, /No applications match the filter\./);
});

// ---- loadTracker ----

test('loadTracker: fetches /api/tracker/load and renders the returned applications', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/load')) return jsonRes({ applications: [app({ company: 'Acme' })], setup: {} });
    if (url.startsWith('/api/companies')) return jsonRes([]);
    return jsonRes({});
  });
  await tracker.loadTracker(false);
  assert.match(global.document.getElementById('tracker-content').innerHTML, /Acme/);
});

test('loadTracker: refresh=true hits /api/tracker/refresh instead of /load', async () => {
  let hitRefresh = false;
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/refresh')) { hitRefresh = true; return jsonRes({ applications: [], setup: {} }); }
    if (url.startsWith('/api/companies')) return jsonRes([]);
    return jsonRes({});
  });
  await tracker.loadTracker(true);
  assert.equal(hitRefresh, true);
});

test('loadTracker: shows a setup banner when Notion/Gmail aren\'t configured', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/load')) {
      return jsonRes({ applications: [], setup: { notion: 'missing_token', gmail: 'needs_auth' } });
    }
    if (url.startsWith('/api/companies')) return jsonRes([]);
    return jsonRes({});
  });
  await tracker.loadTracker(false);
  const banner = global.document.getElementById('tracker-setup-banner');
  assert.ok(banner);
  assert.match(banner.innerHTML, /NOTION_TOKEN/);
  assert.match(banner.innerHTML, /authorise Gmail access/);
});

test('loadTracker: a fetch failure shows an error message instead of throwing', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/load')) throw new Error('network down');
    return jsonRes([]);
  });
  await tracker.loadTracker(false);
  assert.match(global.document.getElementById('tracker-content').innerHTML, /Error: network down/);
});

// ---- openDetail ----

test('openDetail: populates the detail panel from /api/tracker/detail', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/detail')) {
      return jsonRes({
        jobUrl: 'https://example.com/job/1',
        jobDescription: '<p>Great role.</p>',
        emails: [{ subject: 'Thanks for applying', from: 'hr@acme.com', date: 'Jan 1', isOutgoing: false }],
      });
    }
    return jsonRes({});
  });

  tracker.openDetail(app({ company: 'Acme', role: 'Product Manager', notionPageId: 'abc' }));
  await flush();

  assert.equal(global.document.getElementById('detail-company').textContent, 'Acme');
  assert.equal(global.document.getElementById('detail-role').textContent, 'Product Manager');
  assert.equal(global.document.getElementById('detail-job-link').hidden, false);
  assert.match(global.document.getElementById('detail-jd').innerHTML, /Great role\./);
  assert.match(global.document.getElementById('detail-emails').innerHTML, /Thanks for applying/);
});

test('openDetail: a Notion job-description error renders the error instead of the description', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/detail')) return jsonRes({ jobDescriptionError: 'Notion API 404', emails: [] });
    return jsonRes({});
  });
  tracker.openDetail(app());
  await flush();
  assert.match(global.document.getElementById('detail-jd').innerHTML, /Notion error: Notion API 404/);
});

test('openDetail: separates calendar events from regular emails into their own panel', async () => {
  const tracker = await setup(async (url) => {
    if (url.startsWith('/api/tracker/detail')) {
      return jsonRes({
        emails: [
          { subject: 'Interview invite', from: 'a@acme.com', isCalendar: false },
          { subject: 'Interview: Product Manager', from: 'a@acme.com', isCalendar: true },
        ],
      });
    }
    return jsonRes({});
  });
  tracker.openDetail(app());
  await flush();
  assert.match(global.document.getElementById('detail-emails').innerHTML, /Interview invite/);
  assert.doesNotMatch(global.document.getElementById('detail-emails').innerHTML, /Interview: Product Manager/);
  assert.match(global.document.getElementById('detail-calendar').innerHTML, /Interview: Product Manager/);
});
