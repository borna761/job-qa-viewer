// guessCompanyFromTab, companyNamesLooselyMatch, normalizeUrl, STAGE_COLOR:
// see shared.js. guessCompanyFromTab is deliberately simpler than popup.js's
// extractJobInfo — no JobPosting JSON-LD here, since reading it needs
// scripting.executeScript, which needs a user gesture background.js doesn't
// have. tab.title/tab.url are already available from the "tabs" permission
// on every tab, gesture or not, so this is what's cheaply available. A soft
// signal, not authoritative — the popup's own richer detection is what
// actually runs once it's opened.
importScripts('shared.js');

const API = 'http://localhost:3456/api/tracker/urls';
const REFRESH_MINUTES = 5;

let urlMap = null;
let serverOnline = true;
let fetchInFlight = null;
// Distinct from urlMap.size === 0: that's also true for a tracker that's
// genuinely empty, not just one that hasn't been fetched yet. updateTab
// used to retry fetchUrlMap() whenever the map was empty for any reason —
// and fetchUrlMap always calls updateTab again once it settles — so a
// truly empty tracker (or a fetch that keeps coming back with zero
// entries) recursed forever. This flag lets updateTab retry only the
// genuine "never fetched this session" case.
let hasFetchedOnce = false;

// ---- Icon generation (lazy, fully guarded) ----

const ICON_CACHE = new Map();

// badge=true draws a small filled dot in the top-right corner — used to hint
// "you've applied elsewhere at this company" on an untracked posting, without
// needing a whole new set of hand-made icon assets per stage.
function makeFaviconImageData(bgColor = '#1a1a2e', opacity = 1, badge = false) {
  try {
    const sizes = [16, 32, 128];
    const results = {};
    for (const size of sizes) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const sc = size / 32;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      ctx.roundRect(0, 0, size, size, 6 * sc);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2 * sc;
      ctx.beginPath();
      ctx.roundRect(6 * sc, 8 * sc, 20 * sc, 16 * sc, 2 * sc);
      ctx.stroke();
      ctx.lineWidth = 1.5 * sc;
      ctx.lineCap = 'round';
      [[9, 13, 23, 13], [9, 17, 18, 17], [9, 21, 20, 21]].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath(); ctx.moveTo(x1 * sc, y1 * sc); ctx.lineTo(x2 * sc, y2 * sc); ctx.stroke();
      });
      if (badge) {
        // Dark ring behind the dot keeps it legible against light toolbars —
        // and against the orange "Turned Down" stage color specifically,
        // which sits close enough to the badge's amber that a thin ring
        // wasn't enough separation; verified visually across all 6 stage
        // colors before landing on this thickness.
        const r = 7 * sc, cx = 25 * sc, cy = 7 * sc;
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath(); ctx.arc(cx, cy, r - 3 * sc, 0, Math.PI * 2); ctx.fill();
      }
      results[size] = ctx.getImageData(0, 0, size, size);
    }
    return results;
  } catch { return null; }
}

let DEFAULT_ICON = null;
let OFFLINE_ICON = null;
let COMPANY_HISTORY_ICON = null;

function defaultIcon() { return DEFAULT_ICON ??= makeFaviconImageData(); }
function offlineIcon() { return OFFLINE_ICON ??= makeFaviconImageData('#6b7280', 0.35); }
// Shown on an untracked posting when its company has other tracked applications.
function companyHistoryIcon() { return COMPANY_HISTORY_ICON ??= makeFaviconImageData('#1a1a2e', 1, true); }

// badge=true adds the same "other applications at this company" dot to a
// tracked entry's own stage-colored icon — a tracked page shouldn't hide that
// context just because it already has a color of its own.
function iconForStage(stage, badge = false) {
  const cacheKey = badge ? `${stage}::badge` : stage;
  if (!ICON_CACHE.has(cacheKey))
    ICON_CACHE.set(cacheKey, makeFaviconImageData(STAGE_COLOR[stage] || '#6b7280', 1, badge));
  return ICON_CACHE.get(cacheKey);
}

function setIcon(tabId, imageData) {
  if (!imageData) return;
  // Use callback form so chrome.runtime.lastError is always read — suppresses
  // "Unchecked runtime.lastError" when the tab closes between query and call.
  chrome.action.setIcon({ tabId, imageData }, () => void chrome.runtime.lastError);
}

function setTitle({ tabId, title }) {
  chrome.action.setTitle({ tabId, title }, () => void chrome.runtime.lastError);
}

// ---- Persist / restore URL map via storage ----

async function saveMap(entries) {
  await chrome.storage.local.set({ urlEntries: entries });
}

function buildMapFromEntries(entries) {
  const map = new Map();
  for (const { url, company, stage } of entries) {
    const key = normalizeUrl(url);
    if (key) map.set(key, { company, stage });
  }
  return map;
}

async function ensureMap() {
  if (urlMap !== null) return;
  const { urlEntries } = await chrome.storage.local.get('urlEntries');
  urlMap = urlEntries ? buildMapFromEntries(urlEntries) : new Map();
}

// ---- Fetch fresh data from local server ----

async function fetchUrlMap(force = false) {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = (async () => {
    try {
      const url = force ? `${API}?force=1` : API;
      const entries = await fetch(url).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      });
      urlMap = buildMapFromEntries(entries);
      await saveMap(entries);
      serverOnline = true;
    } catch {
      serverOnline = false;
      await ensureMap();
    } finally {
      fetchInFlight = null;
      hasFetchedOnce = true;
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await updateTab(tab.id, tab.url, tab.title);
    } catch {}
  })();
  return fetchInFlight;
}

// ---- Decide, then draw ----
//
// Pure decision logic — no chrome/OffscreenCanvas calls — kept separate from
// resolveIcon/updateTab below specifically so it's testable without a canvas
// polyfill: this is where an actual bug would live (which variant/title for
// which tab state), not in the few lines of canvas drawing each variant
// resolves to.
function decideTabIconState(url, title, serverOnline, urlMap) {
  if (!url || !url.startsWith('http'))
    return { icon: { variant: 'default' }, title: 'Job Tracker' };

  if (!serverOnline)
    return { icon: { variant: 'offline' }, title: 'Job Tracker - server unreachable' };

  const key = normalizeUrl(url);
  const match = key ? urlMap.get(key) : null;

  if (match) {
    // Other tracked entries at the same company, excluding this one. Both
    // sides here are real saved company names (not a title/URL guess), so
    // this is an exact case-insensitive comparison, unlike the loose match
    // used below for the untracked case.
    const matchCompany = match.company.toLowerCase();
    const hasOtherAtCompany = [...urlMap.entries()]
      .some(([k, v]) => k !== key && v.company && v.company.toLowerCase() === matchCompany);
    return {
      icon: { variant: 'stage', stage: match.stage, badge: hasOtherAtCompany },
      title: hasOtherAtCompany
        ? `${match.company} — ${match.stage} (other applications tracked too)`
        : `${match.company} — ${match.stage}`,
    };
  }

  // Not this exact posting — but flag it if the company itself has other
  // tracked applications, so that's visible without opening the popup.
  const guessedCompany = guessCompanyFromTab(title, url);
  const companyMatch = guessedCompany && [...urlMap.values()]
    .some(v => v.company && companyNamesLooselyMatch(guessedCompany, v.company));

  return companyMatch
    ? { icon: { variant: 'companyHistory' }, title: 'Job Tracker - other applications tracked at this company' }
    : { icon: { variant: 'default' }, title: 'Job Tracker - not applied' };
}

// Maps a decideTabIconState() variant to the actual (canvas-drawn) icon —
// the one part of this that genuinely needs OffscreenCanvas, kept
// deliberately trivial so there's nothing here worth testing beyond what
// decideTabIconState already covers.
function resolveIcon({ variant, stage, badge }) {
  if (variant === 'offline') return offlineIcon();
  if (variant === 'companyHistory') return companyHistoryIcon();
  if (variant === 'stage') return iconForStage(stage, badge);
  return defaultIcon();
}

// ---- Update a single tab ----

async function updateTab(tabId, url, title) {
  try {
    await ensureMap();
    if (!hasFetchedOnce) await fetchUrlMap();

    const state = decideTabIconState(url, title, serverOnline, urlMap);
    setIcon(tabId, resolveIcon(state.icon));
    setTitle({ tabId, title: state.title });
  } catch {}
}

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: REFRESH_MINUTES });
  fetchUrlMap();
});
chrome.runtime.onStartup.addListener(fetchUrlMap);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh') fetchUrlMap();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateTab(tabId, tab.url, tab.title);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.url || change.status === 'complete') await updateTab(tabId, tab.url, tab.title);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh') {
    urlMap = null;
    if (msg.force) fetchInFlight = null; // bypass in-flight non-force fetch
    fetchUrlMap(msg.force).then(() => sendResponse({ ok: true }));
    return true;
  }
  // Runs here, not in popup.js: the popup's own JS is torn down the instant
  // it closes, so listeners/timers set there would never fire once we close
  // the popup right after opening the tab.
  //
  // Closes tabId once it's actually finished loading (plus a short buffer
  // for its own redirect JS to run), rather than guessing a single fixed
  // delay up front that has to cover the worst case network/machine speed —
  // and never closes it out from under the user if they've switched to it
  // themselves in the meantime.
  if (msg.type === 'closeTabWhenLoaded') {
    const { tabId } = msg;
    const POST_LOAD_BUFFER_MS = 800;
    const SAFETY_NET_MS = 6000; // in case 'complete' never fires for this tab
    let closed = false;
    const attemptClose = () => {
      if (closed) return;
      closed = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) return; // tab already gone
        if (t?.active) return; // user switched to it — leave it alone
        chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
      });
    };
    const onUpdate = (updatedTabId, change) => {
      if (updatedTabId === tabId && change.status === 'complete')
        setTimeout(attemptClose, POST_LOAD_BUFFER_MS);
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
    setTimeout(attemptClose, SAFETY_NET_MS);
    return false;
  }
});

// Exported for node:test coverage (test/background.test.js) — no-op in the
// real service worker, where `module` doesn't exist. The listener
// registrations above are pure side-effect-free addListener() calls either
// way, so nothing here needs guarding beyond the export itself.
if (typeof module !== 'undefined') {
  module.exports = {
    updateTab, fetchUrlMap, ensureMap, buildMapFromEntries, saveMap,
    iconForStage, defaultIcon, offlineIcon, companyHistoryIcon,
    decideTabIconState,
  };
}
