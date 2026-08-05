const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChromeMock } = require('../test-support/chromeMock');
const { freshRequire, EXT_DIR } = require('../test-support/loadExtensionModule');
const { FakeOffscreenCanvas } = require('../test-support/offscreenCanvasStub');

// background.js does `importScripts('shared.js')` at the top, which is a
// real global in a service worker but doesn't exist in Node — stub it to do
// the equivalent (merge shared.js's exports onto the global scope) so the
// file's own top-level line works unmodified.
function loadBackground(chromeOverrides) {
  global.chrome = createChromeMock(chromeOverrides);
  global.importScripts = file => Object.assign(global, require(path.join(EXT_DIR, file)));
  global.OffscreenCanvas = FakeOffscreenCanvas;
  return freshRequire('background.js');
}

let realFetch;
beforeEach(() => {
  delete global.chrome;
  delete global.importScripts;
  delete global.OffscreenCanvas;
  realFetch = global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

// ---- decideTabIconState (pure decision logic, no OffscreenCanvas needed) ----
// updateTab's actual icon-drawing calls (defaultIcon/offlineIcon/iconForStage/
// companyHistoryIcon) need OffscreenCanvas, which doesn't exist in Node —
// this is the piece of updateTab's logic that's worth testing directly: which
// variant/title gets chosen for a given tab state, independent of how the
// chosen variant gets drawn.

test('decideTabIconState: non-http URL (new tab, chrome:// page, etc.)', () => {
  const bg = loadBackground();
  assert.deepEqual(
    bg.decideTabIconState('chrome://newtab', 'New Tab', true, new Map()),
    { icon: { variant: 'default' }, title: 'Job Tracker' },
  );
  assert.deepEqual(
    bg.decideTabIconState('', '', true, new Map()),
    { icon: { variant: 'default' }, title: 'Job Tracker' },
  );
});

test('decideTabIconState: server unreachable takes priority over everything else', () => {
  const bg = loadBackground();
  const urlMap = new Map([['example.com/job/1', { company: 'Acme', stage: 'Applied' }]]);
  assert.deepEqual(
    bg.decideTabIconState('https://example.com/job/1', 'irrelevant', false, urlMap),
    { icon: { variant: 'offline' }, title: 'Job Tracker - server unreachable' },
  );
});

test('decideTabIconState: exact tracked match, no other applications at the company', () => {
  const bg = loadBackground();
  const urlMap = new Map([['example.com/job/1', { company: 'Acme', stage: 'Applied' }]]);
  assert.deepEqual(
    bg.decideTabIconState('https://example.com/job/1', 'irrelevant', true, urlMap),
    { icon: { variant: 'stage', stage: 'Applied', badge: false }, title: 'Acme — Applied' },
  );
});

test('decideTabIconState: exact tracked match, other applications at the same company exist', () => {
  const bg = loadBackground();
  const urlMap = new Map([
    ['example.com/job/1', { company: 'Acme', stage: 'Applied' }],
    ['example.com/job/2', { company: 'Acme', stage: 'Interviews' }],
  ]);
  assert.deepEqual(
    bg.decideTabIconState('https://example.com/job/1', 'irrelevant', true, urlMap),
    { icon: { variant: 'stage', stage: 'Applied', badge: true }, title: 'Acme — Applied (other applications tracked too)' },
  );
});

test('decideTabIconState: untracked posting, but the company matches a tracked entry (loose match)', () => {
  const bg = loadBackground();
  // "acme" (URL-derived, via a Lever-style host) loosely matches saved "Acme Corp".
  const urlMap = new Map([['other.com/x', { company: 'Acme Corp', stage: 'Applied' }]]);
  assert.deepEqual(
    bg.decideTabIconState('https://jobs.lever.co/acme/xyz', 'Some Role', true, urlMap),
    { icon: { variant: 'companyHistory' }, title: 'Job Tracker - other applications tracked at this company' },
  );
});

test('decideTabIconState: untracked posting, no company match at all', () => {
  const bg = loadBackground();
  const urlMap = new Map([['other.com/x', { company: 'Northwind', stage: 'Applied' }]]);
  assert.deepEqual(
    bg.decideTabIconState('https://example.com/careers/1', 'Some Role', true, urlMap),
    { icon: { variant: 'default' }, title: 'Job Tracker - not applied' },
  );
});

// ---- updateTab (orchestration: ensureMap -> decide -> setIcon/setTitle) ----

test('updateTab: sets the tracked-entry title and a real (non-null) icon end to end', async () => {
  // updateTab always triggers one fetchUrlMap() on first call this session
  // (hasFetchedOnce starts false) — mock fetch too, or this would either
  // hit a real network call or hang.
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ url: 'https://example.com/job/1', company: 'Acme', stage: 'Applied' }],
  });
  const bg = loadBackground({
    activeTab: { id: 1, url: 'https://example.com/job/1', title: 'irrelevant' },
  });
  await bg.updateTab(1, 'https://example.com/job/1', 'irrelevant title');
  assert.deepEqual(global.chrome.action._setTitleCalls.at(-1), { tabId: 1, title: 'Acme — Applied' });
  assert.ok(global.chrome.action._setIconCalls.at(-1).imageData, 'expected a real (non-null) imageData');
});

// ---- fetchUrlMap (caching, and graceful fallback on fetch failure) ----

test('fetchUrlMap: on success, persists entries to storage and refreshes the active tab', async () => {
  const activeTab = { id: 7, url: 'https://example.com/job/1', title: 'irrelevant' };
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ url: 'https://example.com/job/1', company: 'Acme', stage: 'Applied' }],
  });
  const bg = loadBackground({ activeTab });

  await bg.fetchUrlMap(true);

  assert.deepEqual(global.chrome.storage.local._data.urlEntries, [
    { url: 'https://example.com/job/1', company: 'Acme', stage: 'Applied' },
  ]);
  // The active-tab refresh at the end of fetchUrlMap should reflect the
  // freshly-fetched data, not stale/empty state.
  assert.deepEqual(global.chrome.action._setTitleCalls.at(-1), { tabId: 7, title: 'Acme — Applied' });
});

test('fetchUrlMap: on failure, falls back to whatever is already in storage instead of throwing', async () => {
  const activeTab = { id: 7, url: 'https://example.com/job/1', title: 'irrelevant' };
  global.fetch = async () => { throw new Error('network down'); };
  const bg = loadBackground({
    activeTab,
    storageData: { urlEntries: [{ url: 'https://example.com/job/1', company: 'Acme', stage: 'Applied' }] },
  });

  await bg.fetchUrlMap(true); // must not throw

  // serverOnline flipped false — the active tab should now show the
  // "server unreachable" state, not the (still-cached) tracked entry.
  assert.deepEqual(global.chrome.action._setTitleCalls.at(-1), { tabId: 7, title: 'Job Tracker - server unreachable' });
});

test('updateTab: a genuinely empty tracker does not recurse forever', async () => {
  // Regression: updateTab used to retry fetchUrlMap() whenever
  // urlMap.size === 0 — true both for "never fetched yet" and for "fetched,
  // and the tracker is legitimately empty". fetchUrlMap always calls
  // updateTab again once it settles, so a real empty tracker (or any fetch
  // that keeps coming back with zero entries) recursed without end. Counts
  // fetch calls to prove it now settles after exactly one.
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => [] }; };
  const bg = loadBackground({ activeTab: { id: 1, url: 'https://example.com/x', title: 'x' } });

  await bg.updateTab(1, 'https://example.com/x', 'irrelevant');

  assert.equal(fetchCalls, 1);
  assert.deepEqual(global.chrome.action._setTitleCalls.at(-1), { tabId: 1, title: 'Job Tracker - not applied' });
});

// ---- runtime message handlers ----

test('onMessage "refresh": triggers a fetch and calls sendResponse once it settles', async () => {
  global.fetch = async () => ({ ok: true, json: async () => [] });
  const bg = loadBackground({ activeTab: { id: 1, url: 'https://example.com', title: 'x' } });

  let responded = null;
  const [handler] = global.chrome.runtime.onMessage._listeners;
  const keepChannelOpen = handler({ type: 'refresh', force: true }, {}, res => { responded = res; });

  assert.equal(keepChannelOpen, true); // tells chrome the response is async
  await new Promise(r => setTimeout(r, 0)); // let the fetch/then-chain settle
  assert.deepEqual(responded, { ok: true });
});

test('onMessage "closeTabWhenLoaded": removes the tab shortly after it finishes loading', async t => {
  // Array form, not { apis: [...] } — the object form isn't supported by
  // node:test's mock timers on Node 18 (one of this project's CI targets).
  t.mock.timers.enable(['setTimeout']);
  // background.js's own top-level chrome.tabs.onUpdated listener (unrelated
  // to closeTabWhenLoaded) also fires on the _fire() call below and calls
  // updateTab, which triggers one fetchUrlMap() this session — mock fetch
  // so that resolves instead of hitting a real network call.
  global.fetch = async () => ({ ok: true, json: async () => [] });
  loadBackground({ tabs: [{ id: 42, active: false }] });

  const [handler] = global.chrome.runtime.onMessage._listeners;
  const keepChannelOpen = handler({ type: 'closeTabWhenLoaded', tabId: 42 }, {}, () => {});
  assert.equal(keepChannelOpen, false); // synchronous — no async response expected

  // Simulate the tab finishing its load. Real chrome always passes a third
  // (tab) argument to onUpdated listeners — background.js's own top-level
  // listener (separate from closeTabWhenLoaded's own internal one) reads
  // tab.url, so it needs one here too.
  global.chrome.tabs.onUpdated._fire(42, { status: 'complete' }, { id: 42, url: 'https://example.com/x', title: 'x' });
  t.mock.timers.tick(800); // POST_LOAD_BUFFER_MS
  // attemptClose's own chrome.tabs.get(id, cb) resolves via a microtask in
  // the mock (mirroring real chrome's callback-vs-promise duality) — flush
  // the microtask queue so that inner callback has actually run before we
  // check the result. tick() itself is synchronous and doesn't wait for it.
  await Promise.resolve(); await Promise.resolve();

  // chrome.tabs.get(id) with no callback resolves via a promise — must
  // await the resolved value, not the (always-truthy) promise object itself.
  assert.equal(await global.chrome.tabs.get(42), null); // removed

  // There's also a SAFETY_NET_MS (6s) timer still pending (in case
  // 'complete' never fires) — flush it too so nothing outlives the test;
  // attemptClose no-ops immediately since `closed` is already true by now.
  t.mock.timers.tick(6000);
});

test('onMessage "closeTabWhenLoaded": leaves the tab alone if the user switched to it', async t => {
  t.mock.timers.enable(['setTimeout']);
  global.fetch = async () => ({ ok: true, json: async () => [] });
  loadBackground({ tabs: [{ id: 42, active: true }] }); // user is now looking at it

  const [handler] = global.chrome.runtime.onMessage._listeners;
  handler({ type: 'closeTabWhenLoaded', tabId: 42 }, {}, () => {});
  global.chrome.tabs.onUpdated._fire(42, { status: 'complete' }, { id: 42, url: 'https://example.com/x', title: 'x' });
  t.mock.timers.tick(800);
  await Promise.resolve(); await Promise.resolve();

  assert.ok(await global.chrome.tabs.get(42)); // still there

  // Flush the still-pending SAFETY_NET_MS timer too — see the previous
  // test's comment for why.
  t.mock.timers.tick(6000);
});
