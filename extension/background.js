const API = 'http://localhost:3456/api/tracker/urls';
const REFRESH_MINUTES = 5;

const STAGE_COLOR = {
  'Applied':      '#1d4ed8',
  'Phone Screen': '#d97706',
  'On Hold':      '#9ca3af',
  'Interviews':   '#7c3aed',
  'Offer':        '#16a34a',
  'Rejected':     '#dc2626',
  'Turned Down':  '#ea580c',
};

// In-memory map rebuilt from storage on each service-worker wake
let urlMap = null; // null = not loaded yet
let serverOnline = true;
let fetchInFlight = null; // deduplicates concurrent fetchUrlMap() calls

// ---- URL normalisation ----

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    // Strip locale prefix like /en-CA/, /en-US/, /fr/ that some ATS platforms add
    const path = u.pathname.replace(/^\/[a-z]{2}(-[a-z]{2})?\//i, '/').replace(/\/$/, '');
    return (u.hostname + path).toLowerCase();
  } catch { return null; }
}

// ---- Icon generation ----

function makeImageData(fillColor, opacity = 1) {
  const size = 32;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

const ICON_OFFLINE = makeImageData('#9ca3af', 0.35);
const ICON_NEUTRAL = makeImageData('#6b7280');
const ICON_CACHE   = new Map();

function iconForStage(stage) {
  if (!ICON_CACHE.has(stage))
    ICON_CACHE.set(stage, makeImageData(STAGE_COLOR[stage] || '#6b7280'));
  return ICON_CACHE.get(stage);
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
  // Restore from storage so we don't show "not matched" while the fetch is in flight
  const { urlEntries } = await chrome.storage.local.get('urlEntries');
  urlMap = urlEntries ? buildMapFromEntries(urlEntries) : new Map();
}

// ---- Fetch fresh data from local server ----

async function fetchUrlMap() {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = (async () => {
    try {
      const entries = await fetch(API).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      });
      urlMap = buildMapFromEntries(entries);
      await saveMap(entries);
      serverOnline = true;
    } catch {
      serverOnline = false;
      await ensureMap(); // fall back to cached storage
    } finally {
      fetchInFlight = null;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) updateTab(tab.id, tab.url);
  })();
  return fetchInFlight;
}

// ---- Update a single tab ----

async function updateTab(tabId, url) {
  await ensureMap();
  // If map is still empty after storage load, wait for the in-flight fetch (or start one)
  if (urlMap.size === 0) await fetchUrlMap();

  if (!url || !url.startsWith('http')) {
    await chrome.action.setIcon({ tabId, imageData: { 32: ICON_NEUTRAL } });
    await chrome.action.setTitle({ tabId, title: 'Job Tracker' });
    return;
  }
  if (!serverOnline && urlMap.size === 0) {
    await chrome.action.setIcon({ tabId, imageData: { 32: ICON_OFFLINE } });
    await chrome.action.setTitle({ tabId, title: 'Job Tracker – server unreachable' });
    return;
  }

  const key = normalizeUrl(url);
  const match = key ? urlMap.get(key) : null;

  if (match) {
    await chrome.action.setIcon({ tabId, imageData: { 32: iconForStage(match.stage) } });
    await chrome.action.setTitle({ tabId, title: `${match.company} — ${match.stage}` });
  } else {
    await chrome.action.setIcon({ tabId, imageData: { 32: ICON_NEUTRAL } });
    await chrome.action.setTitle({ tabId, title: 'Job Tracker – not applied' });
  }
}

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(fetchUrlMap);
chrome.runtime.onStartup.addListener(fetchUrlMap);

chrome.alarms.create('refresh', { periodInMinutes: REFRESH_MINUTES });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh') fetchUrlMap();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  updateTab(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) updateTab(tabId, change.url);
});
