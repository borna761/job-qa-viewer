// Notion API client + loading job applications from the workspace, plus the
// cached URL map the Chrome extension polls.

async function notionFetch(endpoint, options = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw Object.assign(new Error('NOTION_TOKEN not set'), { code: 'missing_token' });
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllNotionBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const qs  = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const data = await notionFetch(`blocks/${pageId}/children${qs}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

// Maps Notion stage-page titles → tracker stage names
const NOTION_SECTION_MAP = {
  active:      'Applied',
  notapplied:  'Interested',
  interviews:  'Interviews',
  turneddown:  'Turned Down',
  stale:       'Stale',
  inactive:    'Rejected',
  // Any stage page whose title-key isn't listed here is skipped
  // (e.g. a "Don't apply" list → key "dontapply", intentionally omitted).
};

function parseTitleToApp(block, stage) {
  const title      = block.child_page?.title || '';
  const lastUpdate = block.created_time || null;
  // Title format: "[🔗 link] — Role | Company"
  const body    = title.replace(/^\[.*?\]\s*[—–-]\s*/, '');
  const pipeIdx = body.indexOf(' | ');
  if (pipeIdx !== -1) {
    const role    = body.slice(0, pipeIdx).trim().replace(/^(?:job\s+)?application(?:\s+for)?\s*/i, '');
    const company = body.slice(pipeIdx + 3).trim();
    return { company, role: role || null, stage, lastUpdate, source: 'notion', notionPageId: block.id };
  }
  const company = body.trim();
  return company ? { company, role: null, stage, lastUpdate, source: 'notion', notionPageId: block.id } : null;
}

async function loadNotionApps() {
  const topBlocks  = await fetchAllNotionBlocks(process.env.NOTION_PAGE_ID);
  const stagePages = topBlocks.filter(b => {
    if (b.type !== 'child_page' || b.archived || b.in_trash) return false;
    const key = b.child_page.title.toLowerCase().replace(/[^a-z]/g, '');
    if (!NOTION_SECTION_MAP[key]) {
      console.warn(`[tracker] Unknown Notion section ignored: "${b.child_page.title}" (key: "${key}") — add it to NOTION_SECTION_MAP if it should be tracked`);
      return false;
    }
    return true;
  });

  // Fetch all stage pages in parallel
  const stageResults = await Promise.all(stagePages.map(async sp => {
    const key   = sp.child_page.title.toLowerCase().replace(/[^a-z]/g, '');
    const stage = NOTION_SECTION_MAP[key];
    const children = await fetchAllNotionBlocks(sp.id);
    return { stage, children };
  }));

  const apps = [];
  for (const { stage, children } of stageResults) {
    for (const child of children) {
      if (child.type !== 'child_page' || child.archived || child.in_trash) continue;
      const app = parseTitleToApp(child, stage);
      if (app) apps.push(app);
    }
  }
  return apps;
}

let urlMapCache = null;
let urlMapCacheTime = 0;
const URL_MAP_TTL = 60 * 1000;

async function buildUrlMap() {
  const apps = await loadNotionApps();
  const CONCURRENCY = 20;
  const entries = [];
  async function fetchOne(app) {
    if (!app.notionPageId) return;
    try {
      const page = await notionFetch(`pages/${app.notionPageId}`);
      const titleSpans = page.properties?.title?.title || [];
      for (const span of titleSpans) {
        const url = span.href || span.text?.link?.url;
        if (url) {
          entries.push({ url, company: app.company, stage: app.stage, role: app.role || null, lastUpdate: app.lastUpdate || null, notionPageId: app.notionPageId });
          break;
        }
      }
    } catch { /* skip */ }
  }
  for (let i = 0; i < apps.length; i += CONCURRENCY)
    await Promise.allSettled(apps.slice(i, i + CONCURRENCY).map(fetchOne));
  return entries;
}

// Cached wrapper used by /api/tracker/urls. Rebuilds when stale or forced.
async function getUrlMapCached(force) {
  if (urlMapCache && Date.now() - urlMapCacheTime < URL_MAP_TTL && !force)
    return urlMapCache;
  urlMapCache = await buildUrlMap();
  urlMapCacheTime = Date.now();
  return urlMapCache;
}

function invalidateUrlMapCache() {
  urlMapCache = null;
}

module.exports = {
  notionFetch, fetchAllNotionBlocks, NOTION_SECTION_MAP,
  parseTitleToApp, loadNotionApps, buildUrlMap,
  getUrlMapCached, invalidateUrlMapCache,
};
