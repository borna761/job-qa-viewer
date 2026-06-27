const API = 'http://localhost:3456';

const STAGE_COLORS = {
  'Interested':  { bg: '#ecfeff', color: '#0891b2' },
  'Applied':     { bg: '#dbeafe', color: '#1d4ed8' },
  'Interviews':  { bg: '#ede9fe', color: '#5b21b6' },
  'Stale':       { bg: '#f3f4f6', color: '#6b7280' },
  'Turned Down': { bg: '#fff7ed', color: '#c2410c' },
  'Rejected':    { bg: '#fee2e2', color: '#b91c1c' },
};

const SAVE_STAGES = [
  { label: 'Not applied', value: 'Not applied' },
  { label: 'Active',      value: 'Active'      },
];

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/').replace(/\/$/, '');
    path = path.replace(/\/job\/[^/]+\/(.*_r\d+[^/]*)/i, '/job/$1');
    return (u.hostname + path).toLowerCase();
  } catch { return null; }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

function stageBadge(stage) {
  const c = STAGE_COLORS[stage] || { bg: '#f3f4f6', color: '#6b7280' };
  return `<span class="stage-badge" style="background:${c.bg};color:${c.color}">${esc(stage)}</span>`;
}

function extractJobInfo(pageTitle, tabUrl) {
  try {
    const u = new URL(tabUrl);
    const m = u.pathname.match(/\/job\/(?:[^/]+\/)?([^/]+?)(?:_[Rr]\d+)?(?:\/|$)/);
    if (m) {
      const role = m[1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
      const company = u.hostname.replace(/^www\./, '').split('.')[0]
        .replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (role) return { role, company };
    }
  } catch {}

  let title = pageTitle
    .replace(/\s*[-|]\s*(LinkedIn|Greenhouse|Lever|Workday|Indeed|Glassdoor|Jobs|Careers)[^|]*$/i, '')
    .trim();

  const atMatch = title.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: atMatch[1].trim(), company: atMatch[2].trim() };

  const pipeMatch = title.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { role: pipeMatch[1].trim(), company: pipeMatch[2].trim() };

  return { role: title, company: '' };
}

function renderTracked(entry) {
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="company">${esc(entry.company)}</div>
    ${entry.role ? `<div class="role">${esc(entry.role)}</div>` : ''}
    <div class="meta">
      ${stageBadge(entry.stage)}
      <span class="date">${formatDate(entry.lastUpdate)}</span>
    </div>
    <div class="btn-row">
      <button class="open-btn" id="open-tracker">Open Tracker</button>
      <button class="refresh-btn" id="refresh-btn" title="Refresh from Notion">↻</button>
    </div>
    <div class="emails-title">Recent emails</div>
    <div id="emails-list"><p class="no-emails">Loading...</p></div>
  `;

  document.getElementById('open-tracker').addEventListener('click', async () => {
    const [existing] = await chrome.tabs.query({ url: `${API}/*` });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      try { await chrome.windows.update(existing.windowId, { focused: true }); } catch {}
    } else {
      await chrome.tabs.create({ url: API });
    }
    window.close();
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.textContent = '…';
    await new Promise(resolve => chrome.runtime.sendMessage({ type: 'refresh', force: true }, resolve));
    // Re-run init to reflect updated state
    init();
  });

  const params = new URLSearchParams({ company: entry.company });
  if (entry.notionPageId) params.set('notionPageId', entry.notionPageId);
  fetch(`${API}/api/tracker/detail?${params}`)
    .then(r => r.json())
    .then(data => {
      const emails = (data.emails || []).filter(e => !e.isCalendar).slice(0, 3);
      const el = document.getElementById('emails-list');
      if (!el) return;
      if (!emails.length) {
        el.innerHTML = '<p class="no-emails">No emails found.</p>';
        return;
      }
      el.innerHTML = emails.map(e => {
        const cls = /not moving|not selected|regret|unfortunately/i.test(e.subject) ? 'rejected'
          : /interview|technical|coding/i.test(e.subject) ? 'interview' : 'applied';
        return `
          <div class="email-item">
            <div class="email-subject">${esc(e.subject)}<span class="email-label email-label--${cls}">${cls}</span></div>
            <div class="email-meta">${e.isOutgoing ? 'Sent' : 'Received'} - ${esc(e.date || '-')}</div>
          </div>`;
      }).join('');
    })
    .catch(() => {
      const el = document.getElementById('emails-list');
      if (el) el.innerHTML = '<p class="no-emails">Could not load emails.</p>';
    });
}

function renderSaveForm(tabUrl, { role, company }) {
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="save-title">Save to Job Tracker</div>
    <div class="field">
      <label>Role</label>
      <input id="inp-role" type="text" value="${esc(role)}">
    </div>
    <div class="field">
      <label>Company</label>
      <input id="inp-company" type="text" value="${esc(company)}">
    </div>
    <div class="field">
      <label>Stage</label>
      <select id="inp-stage">
        ${SAVE_STAGES.map(s => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join('')}
      </select>
    </div>
    <button class="save-btn" id="save-btn">Save to Notion</button>
    <div class="status" id="save-status"></div>
  `;

  document.getElementById('save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('save-btn');
    const statusEl = document.getElementById('save-status');
    const roleVal    = document.getElementById('inp-role').value.trim();
    const companyVal = document.getElementById('inp-company').value.trim();
    const stageVal   = document.getElementById('inp-stage').value;

    if (!companyVal) {
      statusEl.className = 'status status--err';
      statusEl.textContent = 'Company is required.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving...';
    statusEl.textContent = '';

    // Extract job description HTML directly from the rendered page DOM.
    // This works for SPAs (LinkedIn, Greenhouse, etc.) where server-side fetch
    // would get an unauthenticated/incomplete page.
    let pageHtml = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const SELECTORS = [
            // LinkedIn
            '.jobs-description__content',
            '.jobs-description',
            '#job-details',
            // Greenhouse
            '#content .job__description',
            '.job-post--description',
            // Lever
            '.posting-description',
            // Workday
            '[data-automation-id="jobPostingDescription"]',
            // Ashby
            '[class*="JobPosting"]',
            // Generic
            '[class*="job-description"]',
            '[class*="jobDescription"]',
            '[class*="description-content"]',
          ];
          for (const sel of SELECTORS) {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim().length > 200) return el.innerHTML;
          }
          // Fallback: largest block of text that isn't nav/header/footer
          let best = null, bestLen = 0;
          for (const el of document.querySelectorAll('article, main, section, div')) {
            if (el.closest('nav, header, footer, aside')) continue;
            const len = el.innerText?.trim().length || 0;
            if (len > bestLen && len < 50000) { bestLen = len; best = el; }
          }
          return best && bestLen > 200 ? best.innerHTML : '';
        },
      });
      pageHtml = result?.result || '';
    } catch { /* scripting not available on this page — server will re-fetch */ }

    try {
      const res = await fetch(`${API}/api/tracker/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: tabUrl, role: roleVal, company: companyVal, stage: stageVal, pageHtml }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      statusEl.className = 'status status--ok';
      statusEl.textContent = 'Saved!';
      chrome.runtime.sendMessage({ type: 'refresh' });
    } catch (e) {
      statusEl.className = 'status status--err';
      statusEl.textContent = 'Error: ' + e.message;
      btn.disabled = false;
      btn.textContent = 'Save to Notion';
    }
  });
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith('http')) {
      document.getElementById('root').innerHTML = '<p class="loading" style="padding:14px">Not a job page.</p>';
      return;
    }

    const key = normalizeUrl(tab.url);
    const { urlEntries } = await chrome.storage.local.get('urlEntries');
    const entries = urlEntries || [];
    const match = key ? entries.find(e => normalizeUrl(e.url) === key) : null;

    if (match) {
      renderTracked(match);
    } else {
      renderSaveForm(tab.url, extractJobInfo(tab.title || '', tab.url));
    }
  } catch (e) {
    document.getElementById('root').innerHTML = '<p class="loading" style="padding:14px">Error: ' + e.message + '</p>';
  }
}

init();
