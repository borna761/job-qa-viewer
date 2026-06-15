// ---- Applications Tracker ----

const STAGES = ['Applied', 'Phone Screen', 'On Hold', 'Interviews', 'Offer', 'Rejected'];
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));

// Display sort order: active stages first, rejected last
const STAGE_SORT = {
  'Interviews':   0,
  'Offer':        1,
  'Phone Screen': 2,
  'Applied':      3,
  'On Hold':      4,
  'Rejected':     5,
};
const STAGE_COLORS = {
  'Applied':      { bg: '#dbeafe', color: '#1d4ed8' },
  'Phone Screen': { bg: '#fef9c3', color: '#854d0e' },
  'On Hold':      { bg: '#f3f4f6', color: '#6b7280' },
  'Interviews':   { bg: '#ede9fe', color: '#5b21b6' },
  'Offer':        { bg: '#dcfce7', color: '#15803d' },
  'Rejected':     { bg: '#fee2e2', color: '#b91c1c' },
};

let appsCache        = null;
let knownFiles       = new Set();
let activeStageFilter = null;
let trackerLoaded    = false;

// ---- Merge (client side for incremental refresh) ----

function stageRank(s) { return STAGE_RANK[s] ?? -1; }

// Notion is source of truth — Gmail refresh only updates stage for existing entries
function mergeApps(base, updates) {
  const map = new Map(base.map(a => [a.company.toLowerCase(), { ...a }]));
  for (const u of updates) {
    if (!u.company) continue;
    const key = u.company.toLowerCase();
    if (!map.has(key)) continue;
    const cur = map.get(key);
    if (stageRank(u.stage) > stageRank(cur.stage))
      map.set(key, { ...cur, stage: u.stage, lastUpdate: u.lastUpdate || cur.lastUpdate });
  }
  return [...map.values()];
}

// ---- Notes indicator ----

function companyToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hasNotes(company) {
  return knownFiles.has(companyToSlug(company) + '.txt');
}

// ---- Rendering ----

function stageBadgeHtml(stage) {
  const c = STAGE_COLORS[stage] || { bg: '#f3f4f6', color: '#6b7280' };
  return `<span class="stage-badge" style="background:${c.bg};color:${c.color}">${esc(stage || '—')}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return dateStr; }
}

function renderStats(apps) {
  const interviews = apps.filter(a => a.stage === 'Interviews').length;
  const awaiting   = apps.filter(a => a.stage === 'Applied' || a.stage === 'Phone Screen').length;
  const rejected   = apps.filter(a => a.stage === 'Rejected').length;
  document.getElementById('tracker-stats').innerHTML = `
    <div class="stat-chip">${apps.length} <span>Total</span></div>
    <div class="stat-chip stat-interviews">${interviews} <span>Interviewing</span></div>
    <div class="stat-chip stat-awaiting">${awaiting} <span>Awaiting</span></div>
    <div class="stat-chip stat-rejected">${rejected} <span>Rejected</span></div>
  `;
}

function renderStageFilters(apps) {
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  apps.forEach(a => { if (a.stage in counts) counts[a.stage]++; });
  const el = document.getElementById('stage-filters');
  el.innerHTML =
    `<button class="filter-btn ${!activeStageFilter ? 'active' : ''}" data-stage="">All</button>` +
    STAGES.filter(s => counts[s] > 0).map(s =>
      `<button class="filter-btn ${activeStageFilter === s ? 'active' : ''}" data-stage="${esc(s)}">${esc(s)} <span>${counts[s]}</span></button>`
    ).join('');
  el.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeStageFilter = btn.dataset.stage || null;
      renderTracker(appsCache);
    });
  });
}

function renderTable(apps) {
  const content = document.getElementById('tracker-content');
  if (!apps.length) {
    content.innerHTML = '<div class="empty">No applications match the filter.</div>';
    return;
  }
  const sorted = [...apps].sort((a, b) => {
    const sd = (STAGE_SORT[a.stage] ?? 9) - (STAGE_SORT[b.stage] ?? 9);
    if (sd !== 0) return sd;
    // Within each stage: most recently updated first
    if (a.lastUpdate && b.lastUpdate) return b.lastUpdate.localeCompare(a.lastUpdate);
    if (a.lastUpdate) return -1;
    if (b.lastUpdate) return 1;
    return a.company.localeCompare(b.company);
  });
  content.innerHTML = `
    <table class="apps-table">
      <thead><tr>
        <th>Company</th><th>Role</th><th>Stage</th><th>Last Update</th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${sorted.map(a => `
          <tr class="app-row" data-company="${esc(a.company)}">
            <td class="app-company">${esc(a.company)}</td>
            <td class="app-role">${esc(a.role || '—')}</td>
            <td>${stageBadgeHtml(a.stage)}</td>
            <td class="app-date">${formatDate(a.lastUpdate)}</td>
            <td class="app-notes">${hasNotes(a.company) ? `<span class="notes-badge" title="View Q&amp;A notes">📝</span>` : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  // Row click → detail panel; notes badge click → Q&A tab
  content.querySelectorAll('.app-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.notes-badge')) return;
      const app = (activeStageFilter ? appsCache.filter(a => a.stage === activeStageFilter) : appsCache)
        .find(a => a.company === row.dataset.company);
      if (app) openDetail(app);
    });
  });
  content.querySelectorAll('.notes-badge').forEach(badge => {
    badge.addEventListener('click', () => switchToQAForCompany(badge.closest('.app-row').dataset.company));
  });
}

function renderTracker(apps) {
  renderStats(apps);
  renderStageFilters(apps);
  renderTable(activeStageFilter ? apps.filter(a => a.stage === activeStageFilter) : apps);
}

// ---- Setup warning banner ----

function renderSetupBanner(setup) {
  const existing = document.getElementById('tracker-setup-banner');
  if (existing) existing.remove();

  const issues = [];
  if (setup.notion === 'missing_token')
    issues.push('Notion: set <code>NOTION_TOKEN</code> env var and restart the server.');
  if (setup.gmail === 'missing_client')
    issues.push('Gmail: set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> env vars.');
  if (setup.gmail === 'needs_auth')
    issues.push('Gmail: <a href="/api/tracker/auth" target="_blank">authorise Gmail access</a> (opens in new tab).');

  if (!issues.length) return;

  const banner = document.createElement('div');
  banner.id = 'tracker-setup-banner';
  banner.className = 'tracker-setup-banner';
  banner.innerHTML = `<strong>Setup needed:</strong><ul>${issues.map(i => `<li>${i}</li>`).join('')}</ul>`;
  document.getElementById('tracker-content').before(banner);
}

// ---- Load / refresh ----

async function loadTracker(refresh) {
  const btn     = document.getElementById('tracker-refresh');
  const content = document.getElementById('tracker-content');
  if (btn) btn.disabled = true;
  content.innerHTML = `<div class="empty">⟳&thinsp; ${refresh ? 'Refreshing from Gmail…' : 'Fetching from Notion and Gmail…'}</div>`;

  try {
    if (!refresh || !appsCache) {
      const data = await fetch('/api/tracker/load').then(r => r.json());
      appsCache = data.applications || [];
      renderSetupBanner(data.setup || {});
    } else {
      const data = await fetch('/api/tracker/refresh').then(r => r.json());
      appsCache = mergeApps(appsCache, data.applications || []);
      renderSetupBanner(data.setup || {});
    }

    if (knownFiles.size === 0) {
      const companiesData = await fetch('/api/companies').then(r => r.json()).catch(() => []);
      knownFiles = new Set(companiesData.map(c => c.file));
    }

    trackerLoaded = true;
    renderTracker(appsCache);
  } catch (e) {
    content.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- Detail panel ----

function openDetail(app) {
  const panel = document.getElementById('detail-panel');
  document.getElementById('detail-company').textContent = app.company;
  document.getElementById('detail-role').textContent    = app.role || '';
  document.getElementById('detail-stage-badge').innerHTML = stageBadgeHtml(app.stage);

  const loading = '<p class="detail-loading">Loading…</p>';
  document.getElementById('detail-jd').innerHTML       = loading;
  document.getElementById('detail-emails').innerHTML   = loading;
  document.getElementById('detail-calendar').innerHTML = loading;

  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));

  const params = new URLSearchParams({ company: app.company });
  if (app.notionPageId) params.set('notionPageId', app.notionPageId);

  fetch(`/api/tracker/detail?${params}`)
    .then(r => r.json())
    .then(data => {
      document.getElementById('detail-jd').innerHTML =
        data.jobDescription || '<p class="detail-empty">No description in Notion.</p>';

      const emails   = (data.emails || []).filter(e => !e.isCalendar);
      const calendar = (data.emails || []).filter(e => e.isCalendar);

      document.getElementById('detail-emails').innerHTML = emails.length
        ? emails.map(emailCardHtml).join('')
        : '<p class="detail-empty">No emails found.</p>';

      document.getElementById('detail-calendar').innerHTML = calendar.length
        ? calendar.map(emailCardHtml).join('')
        : '<p class="detail-empty">No calendar events found.</p>';
    })
    .catch(e => {
      document.getElementById('detail-jd').innerHTML =
        `<p class="detail-empty">Error loading details: ${esc(e.message)}</p>`;
      document.getElementById('detail-emails').innerHTML   = '';
      document.getElementById('detail-calendar').innerHTML = '';
    });
}

function emailCardHtml(e) {
  const dir = e.isOutgoing ? 'outgoing' : 'incoming';
  const label = e.isOutgoing ? '↑ Sent' : '↓ Received';
  return `
    <div class="detail-email detail-email--${dir}">
      <div class="detail-email-header">
        <span class="detail-email-subject">${esc(e.subject)}</span>
        <span class="detail-email-dir">${label}</span>
      </div>
      <div class="detail-email-meta">${esc(e.from)} · ${e.date || '—'}</div>
      <div class="detail-email-body">${e.bodyHtml || ''}</div>
    </div>
  `;
}

function closeDetail() {
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('open');
  setTimeout(() => { panel.hidden = true; }, 250);
}

function initDetailPanel() {
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', closeDetail);
}

// ---- Switch to Q&A tab filtered by company ----

function switchToQAForCompany(company) {
  document.querySelector('.tab-btn[data-tab="qa"]').click();
  setTimeout(() => {
    document.querySelectorAll('.nav-company').forEach(el => {
      if (el.dataset.company?.toLowerCase() === company.toLowerCase()) el.click();
    });
  }, 60);
}

// ---- Tab switching ----

function initTrackerTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      const qaView    = document.getElementById('qa-view');
      const trackerView = document.getElementById('tracker-view');
      const qaOnly    = document.querySelectorAll('[data-qa-only]');
      if (tab === 'tracker') {
        qaView.hidden = true; trackerView.hidden = false;
        qaOnly.forEach(el => { el.style.visibility = 'hidden'; });
        if (!trackerLoaded) loadTracker(false);
      } else {
        qaView.hidden = false; trackerView.hidden = true;
        qaOnly.forEach(el => { el.style.visibility = ''; });
      }
    });
  });
  document.getElementById('tracker-refresh').addEventListener('click', () => loadTracker(true));
}

initTrackerTabs();
initDetailPanel();
