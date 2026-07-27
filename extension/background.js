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

// ---- Best-effort company guess for untracked postings ----
//
// Used only for the "you have other applications at this company" icon
// hint — deliberately simpler than popup.js's extractJobInfo: no JobPosting
// JSON-LD here, since reading it needs scripting.executeScript, which needs
// a user gesture background.js doesn't have. tab.title/tab.url are already
// available from the "tabs" permission on every tab, gesture or not, so this
// is what's cheaply available. A soft signal, not authoritative — the
// popup's own richer detection is what actually runs once it's opened.
function guessCompanyFromTab(title, tabUrl) {
  try {
    const u = new URL(tabUrl);
    const host = u.hostname.replace(/^www\./, '');

    // Hosted ATS boards that put the company slug directly in the path —
    // e.g. jobs.lever.co/acme/…, jobs.ashbyhq.com/acme/…,
    // boards.greenhouse.io/acme/jobs/1234 (or job-boards.greenhouse.io).
    // These never match the /job/ pattern below (Lever/Ashby have no "job"
    // segment at all, and Greenhouse uses "/jobs/" — plural, so it doesn't
    // match "/job/" either), so without this they fell through to the much
    // less reliable title-guessing and typically returned no company at all.
    if (/(^|\.)(lever\.co|ashbyhq\.com|greenhouse\.io)$/.test(host)) {
      const slug = u.pathname.split('/').filter(Boolean)[0];
      if (slug) return slug;
    }

    // Workday tenants — acme.myworkdayjobs.com (the real-world form, often
    // with a region label too: acme.wd1.myworkdayjobs.com) or the shorter
    // acme.myworkday.com. Either way company is the first hostname label,
    // not the label before the TLD — unlike the company-owned-domain case
    // below, there's no "careers." subdomain prefix to skip past. Anchored
    // the same way as the lever/ashby/greenhouse check above — a bare
    // .endsWith() would also match a lookalike like "evilmyworkdayjobs.com".
    if (/(^|\.)(myworkdayjobs\.com|myworkday\.com)$/.test(host)) return host.split('.')[0];

    // Loxo tenants — acme.app.loxo.co: same tenant-subdomain shape as
    // Workday above, so the same "first label" extraction applies.
    if (/(^|\.)app\.loxo\.co$/.test(host)) return host.split('.')[0];

    if (/\/job\/(?:[^/]+\/)?[^/]+?(?:_[Rr]\d+)?(?:\/|$)/.test(u.pathname)) {
      // Take the label just before the TLD, not always the first label —
      // "careers.zenith.com" is the company's own domain but the
      // company name is "zenith", not "careers".
      const parts = host.split('.');
      return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    }
  } catch {}
  if (!title) return null;
  const t = title.replace(/\s*[-|]\s*(LinkedIn|Greenhouse|Lever|Workday|Indeed|Glassdoor|Jobs|Careers)[^|]*$/i, '').trim();
  const atWordMatch = t.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atWordMatch) return atWordMatch[2].trim();
  // "Role @ Company" — the actual format Ashby-hosted job page titles use.
  const atSymbolMatch = t.match(/^(.+?)\s*@\s*(.+)$/);
  if (atSymbolMatch) return atSymbolMatch[2].trim();
  const pipeMatch = t.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return pipeMatch[2].trim();
  return null;
}

// Loose match, not exact: a title/hostname-derived guess ("acmewidgets")
// often won't equal the company's saved display name ("Acme") exactly, so
// this is a substring check in either direction. A minimum length guard
// avoids trivial false positives from very short names.
function companyNamesLooselyMatch(a, b) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 3) return false;
  return longer.includes(shorter);
}

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
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await updateTab(tab.id, tab.url, tab.title);
    } catch {}
  })();
  return fetchInFlight;
}

// ---- Update a single tab ----

async function updateTab(tabId, url, title) {
  try {
    await ensureMap();
    if (urlMap.size === 0) await fetchUrlMap();

    if (!url || !url.startsWith('http')) {
      setIcon(tabId, defaultIcon());
      setTitle({ tabId, title: 'Job Tracker' });
      return;
    }
    if (!serverOnline) {
      setIcon(tabId, offlineIcon());
      setTitle({ tabId, title: 'Job Tracker - server unreachable' });
      return;
    }

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
      setIcon(tabId, iconForStage(match.stage, hasOtherAtCompany));
      setTitle({ tabId, title: hasOtherAtCompany
        ? `${match.company} — ${match.stage} (other applications tracked too)`
        : `${match.company} — ${match.stage}` });
      return;
    }

    // Not this exact posting — but flag it if the company itself has other
    // tracked applications, so that's visible without opening the popup.
    const guessedCompany = guessCompanyFromTab(title, url);
    const companyMatch = guessedCompany && [...urlMap.values()]
      .some(v => v.company && companyNamesLooselyMatch(guessedCompany, v.company));

    if (companyMatch) {
      setIcon(tabId, companyHistoryIcon());
      setTitle({ tabId, title: 'Job Tracker - other applications tracked at this company' });
    } else {
      setIcon(tabId, defaultIcon());
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
