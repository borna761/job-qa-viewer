const API = 'http://localhost:3456/api/tracker/urls';
const REFRESH_MINUTES = 5;

const STAGE_COLOR = {
  'Interested':  '#0891b2',
  'Applied':     '#1d4ed8',
  'Interviews':  '#7c3aed',
  'Stale':       '#9ca3af',
  'Turned Down': '#ea580c',
  'Rejected':    '#dc2626',
};

let urlMap = null;
let serverOnline = true;
let fetchInFlight = null;

// ---- URL normalisation ----

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/').replace(/\/$/, '');
    path = path.replace(/\/job\/[^/]+\/(.*_r\d+[^/]*)/i, '/job/$1');
    return (u.hostname + path).toLowerCase();
  } catch { return null; }
}

// ---- Icon generation (lazy, fully guarded) ----

const ICON_CACHE = new Map();

function makeImageData(fillColor, opacity = 1) {
  try {
    const size = 32;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  } catch { return null; }
}

function iconForStage(stage) {
  if (!ICON_CACHE.has(stage))
    ICON_CACHE.set(stage, makeImageData(STAGE_COLOR[stage] || '#6b7280'));
  return ICON_CACHE.get(stage);
}

function setIcon(tabId, imageData) {
  if (!imageData) return;
  // Use callback form so chrome.runtime.lastError is always read — suppresses
  // "Unchecked runtime.lastError" when the tab closes between query and call.
  chrome.action.setIcon({ tabId, imageData: { 32: imageData } }, () => void chrome.runtime.lastError);
}

function setTitle(tabId, title) {
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
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await updateTab(tab.id, tab.url);
    } catch {}
  })();
  return fetchInFlight;
}

// ---- Update a single tab ----

async function updateTab(tabId, url) {
  try {
    await ensureMap();
    if (urlMap.size === 0) await fetchUrlMap();

    if (!url || !url.startsWith('http')) {
      await setIcon(tabId, makeImageData('#6b7280'));
      setTitle({ tabId, title: 'Job Tracker' });
      return;
    }
    if (!serverOnline && urlMap.size === 0) {
      await setIcon(tabId, makeImageData('#9ca3af', 0.35));
      setTitle({ tabId, title: 'Job Tracker - server unreachable' });
      return;
    }

    const key = normalizeUrl(url);
    const match = key ? urlMap.get(key) : null;

    if (match) {
      await setIcon(tabId, iconForStage(match.stage));
      setTitle({ tabId, title: `${match.company} — ${match.stage}` });
    } else {
      await setIcon(tabId, makeImageData('#6b7280'));
      setTitle({ tabId, title: 'Job Tracker - not applied' });
    }
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
    await updateTab(tabId, tab.url);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.url || change.status === 'complete') await updateTab(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh') {
    urlMap = null;
    if (msg.force) fetchInFlight = null; // bypass in-flight non-force fetch
    fetchUrlMap(msg.force).then(() => sendResponse({ ok: true }));
    return true;
  }
});
