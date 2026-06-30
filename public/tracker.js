// ---- Applications Tracker ----

const STAGES = ['Interviews', 'Applied', 'Interested', 'Stale', 'Turned Down', 'Rejected'];
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));

// Display sort order: active stages first, terminal stages last
const STAGE_SORT = {
  'Interviews':  0,
  'Applied':     1,
  'Interested':  2,
  'Stale':       3,
  'Turned Down': 4,
  'Rejected':    5,
};
const STAGE_COLORS = {
  'Interested':  { bg: '#ecfeff', color: '#0891b2' },
  'Applied':     { bg: '#dbeafe', color: '#1d4ed8' },
  'Interviews':  { bg: '#ede9fe', color: '#5b21b6' },
  'Stale':       { bg: '#f3f4f6', color: '#6b7280' },
  'Turned Down': { bg: '#fff7ed', color: '#c2410c' },
  'Rejected':    { bg: '#fee2e2', color: '#b91c1c' },
};

let appsCache        = null;
let knownFiles       = new Set();
let activeStageFilter = null;
let trackerSearch    = '';
let trackerLoaded    = false;

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
    return new Date(dateStr).toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return dateStr; }
}

function renderStats(apps) {
  const interviews = apps.filter(a => a.stage === 'Interviews').length;
  const applied    = apps.filter(a => a.stage === 'Applied').length;
  const stale      = apps.filter(a => a.stage === 'Stale').length;
  const turnedDown = apps.filter(a => a.stage === 'Turned Down').length;
  const rejected   = apps.filter(a => a.stage === 'Rejected').length;
  document.getElementById('tracker-stats').innerHTML = `
    <div class="stat-chip">${apps.length} <span>Total</span></div>
    <div class="stat-chip stat-interviews">${interviews} <span>Interviewing</span></div>
    <div class="stat-chip stat-awaiting">${applied} <span>Applied</span></div>
    ${stale ? `<div class="stat-chip stat-stale">${stale} <span>Stale</span></div>` : ''}
    ${turnedDown ? `<div class="stat-chip stat-turneddown">${turnedDown} <span>Turned Down</span></div>` : ''}
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
    // Primary: most recently updated first; null dates sink to bottom
    if (a.lastUpdate && b.lastUpdate) {
      const dd = b.lastUpdate.localeCompare(a.lastUpdate);
      if (dd !== 0) return dd;
    } else if (a.lastUpdate) return -1;
    else if (b.lastUpdate) return 1;
    // Tiebreak: stage order, then company name
    const sd = (STAGE_SORT[a.stage] ?? 9) - (STAGE_SORT[b.stage] ?? 9);
    if (sd !== 0) return sd;
    return a.company.localeCompare(b.company);
  });
  content.innerHTML = `
    <table class="apps-table">
      <thead><tr>
        <th>Role</th><th>Company</th><th>Stage</th><th>Last Update</th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${sorted.map((a, i) => `
          <tr class="app-row" data-idx="${i}" data-company="${esc(a.company)}">
            <td class="app-role">${esc(a.role || '—')}</td>
            <td class="app-company">${esc(a.company)}</td>
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
      const app = sorted[+row.dataset.idx];
      if (app) openDetail(app);
    });
  });
  content.querySelectorAll('.notes-badge').forEach(badge => {
    badge.addEventListener('click', () => switchToQAForCompany(badge.closest('.app-row').dataset.company));
  });
}

function filterApps(apps) {
  let out = activeStageFilter ? apps.filter(a => a.stage === activeStageFilter) : apps;
  if (trackerSearch) {
    const q = trackerSearch.toLowerCase();
    out = out.filter(a =>
      a.company.toLowerCase().includes(q) ||
      (a.role || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function renderTracker(apps) {
  renderStats(apps);
  renderStageFilters(apps);
  renderTable(filterApps(apps));
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
  content.innerHTML = `<div class="empty">⟳&thinsp; ${refresh ? 'Refreshing…' : 'Fetching from Notion and Gmail…'}</div>`;

  try {
    const url = refresh ? '/api/tracker/refresh' : '/api/tracker/load';
    const data = await fetch(url).then(r => r.json());
    appsCache = data.applications || [];
    renderSetupBanner(data.setup || {});

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
  document.getElementById('detail-job-link').hidden = true;

  const loading = '<p class="detail-loading">Loading…</p>';
  document.getElementById('detail-jd').innerHTML       = loading;
  document.getElementById('detail-emails').innerHTML   = loading;
  document.getElementById('detail-calendar').innerHTML = loading;

  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));

  const params = new URLSearchParams({ company: app.company });
  if (app.notionPageId) params.set('notionPageId', app.notionPageId);
  if (app.role) params.set('role', app.role);

  fetch(`/api/tracker/detail?${params}`)
    .then(r => r.json())
    .then(data => {
      const linkEl = document.getElementById('detail-job-link');
      if (data.jobUrl) {
        linkEl.href = data.jobUrl;
        linkEl.hidden = false;
      }

      const jdEl = document.getElementById('detail-jd');
      jdEl.innerHTML =
        data.jobDescriptionError
          ? `<p class="detail-error">Notion error: ${esc(data.jobDescriptionError)}</p>`
          : data.jobDescription || '<p class="detail-empty">No description in Notion.</p>';
      jdEl.scrollTop = 0;

      const gmailErrorHtml = data.emailsError
        ? `<p class="detail-error">${gmailErrorMessage(data.emailsError)}</p>`
        : null;

      const emails   = (data.emails || []).filter(e => !e.isCalendar);
      const calendar = (data.emails || []).filter(e => e.isCalendar);

      renderEmails('detail-emails',   emails,   gmailErrorHtml, 'No emails found.');
      renderEmails('detail-calendar', calendar, gmailErrorHtml, 'No calendar events found.');
    })
    .catch(e => {
      document.getElementById('detail-jd').innerHTML =
        `<p class="detail-error">Error loading details: ${esc(e.message)}</p>`;
      document.getElementById('detail-emails').innerHTML   = '';
      document.getElementById('detail-calendar').innerHTML = '';
    });
}

function gmailErrorMessage(err) {
  const isTokenError = /expired|revoked|invalid.?(token|grant)|Token/i.test(err);
  if (isTokenError)
    return `Gmail authorisation expired. <a href="/api/tracker/auth" target="_blank">Re-authorise Gmail</a> then refresh.`;
  return `Gmail error: ${esc(err)}`;
}

function emailCardHtml(e, idx) {
  const dir = e.isOutgoing ? 'outgoing' : 'incoming';
  const label = e.isOutgoing ? '↑ Sent' : '↓ Received';
  // The body goes into a sandboxed iframe (filled in by renderEmails), never
  // inline — see the security note there.
  return `
    <div class="detail-email detail-email--${dir}">
      <div class="detail-email-header">
        <span class="detail-email-subject">${esc(e.subject)}</span>
        <span class="detail-email-dir">${label}</span>
      </div>
      <div class="detail-email-meta">${esc(e.from)} · ${e.date || '—'}</div>
      <iframe class="detail-email-body" data-email-idx="${idx}"
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerpolicy="no-referrer" title="Email body"></iframe>
    </div>
  `;
}

// Render email cards, loading each body into a sandboxed iframe via srcdoc.
// The sandbox has no `allow-scripts`, so scripts embedded in an email can never
// execute. This is the security boundary — email HTML is untrusted (an attacker
// can email the user), and the app runs unauthenticated on localhost with access
// to the user's Notion and Gmail. `allow-same-origin` is included only so the
// parent can read the frame's scrollHeight to size it; without `allow-scripts`
// it does not let the framed content run code.
function renderEmails(containerId, list, errorHtml, emptyText) {
  const el = document.getElementById(containerId);
  if (errorHtml != null) { el.innerHTML = errorHtml; return; }
  if (!list.length) { el.innerHTML = `<p class="detail-empty">${esc(emptyText)}</p>`; return; }
  el.innerHTML = list.map(emailCardHtml).join('');
  el.querySelectorAll('iframe.detail-email-body').forEach(frame => {
    const e = list[+frame.dataset.emailIdx];
    frame.addEventListener('load', () => {
      try {
        const h = frame.contentDocument?.body?.scrollHeight;
        if (h) frame.style.height = Math.min(h, 320) + 'px';
      } catch { /* sizing is best-effort */ }
    });
    frame.srcdoc =
      `<!doctype html><meta charset="utf-8"><base target="_blank">` +
      `<style>html{overflow-x:hidden}body{margin:0;` +
      `font:0.8rem/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `color:#374151;word-break:break-word}img{max-width:100%;height:auto}` +
      `a{color:#2563eb}table{max-width:100%;font-size:inherit}</style>` +
      (e.bodyHtml || '');
  });
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

  document.getElementById('tracker-search').addEventListener('input', e => {
    trackerSearch = e.target.value.trim();
    if (appsCache) renderTracker(appsCache);
  });
}

initTrackerTabs();
initDetailPanel();
