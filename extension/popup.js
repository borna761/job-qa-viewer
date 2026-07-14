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
  try { return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

function stageBadge(stage) {
  const c = STAGE_COLORS[stage] || { bg: '#f3f4f6', color: '#6b7280' };
  return `<span class="stage-badge" style="background:${c.bg};color:${c.color}">${esc(stage)}</span>`;
}

// Capitalize the first letter of each word without altering punctuation —
// safe for already human-readable strings like a JSON-LD job title
// ("EverPro - Product Manager" must keep its "-", not lose it to spaces).
// Also fixes letter-digit-letter tokens (b2b -> B2B, b2c -> B2C, p2p -> P2P):
// that shape is essentially always an X-to-Y business acronym, never a real
// word, so it's safe to always fully uppercase.
function capitalizeWords(s) {
  return s
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\b[a-zA-Z]\d[a-zA-Z]\b/g, m => m.toUpperCase())
    .trim();
}

// Slug -> Title Case: also turns hyphens/underscores into spaces, since
// these inputs are dash-joined slugs (e.g. from a URL path), not prose.
function titleCase(s) {
  return capitalizeWords(s.replace(/[-_]/g, ' '));
}

// Read role/company from the page's JobPosting JSON-LD, when present. This is
// injected into the tab via chrome.scripting.executeScript, so it must be a
// self-contained function (no closures over the outer scope).
function readJobPostingJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let json;
    try { json = JSON.parse(s.textContent); } catch { continue; }
    const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
    for (const node of nodes) {
      if (node && node['@type'] === 'JobPosting') {
        const role = node.title;
        const company = node.hiringOrganization && node.hiringOrganization.name;
        if (role && company) return { role, company };
      }
    }
  }
  return null;
}

// Fallback when there's no JobPosting JSON-LD: guess role/company from the
// tab title. Unreliable on career sites that render the title as a
// breadcrumb ("Job postings | Role | Location | Company | site.com") — the
// JSON-LD path above is preferred whenever it's available.
function extractJobInfo(pageTitle, tabUrl) {
  try {
    const u = new URL(tabUrl);
    const m = u.pathname.match(/\/job\/(?:[^/]+\/)?([^/]+?)(?:_[Rr]\d+)?(?:\/|$)/);
    if (m) {
      const role = titleCase(m[1]);
      const company = titleCase(u.hostname.replace(/^www\./, '').split('.')[0]);
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

// app.notion.com/native/p/{id} is Notion's own app-launch bridge page (what
// notion.so/{id} redirects to anyway) — linking here directly skips that
// redirect hop. It degrades gracefully ("continue in your browser") when the
// desktop app isn't installed, and needs no dashes/title slug in the id.
function notionPageUrl(pageId) {
  return `https://app.notion.com/native/p/${pageId.replace(/-/g, '')}`;
}

// Other tracked applications at the same company — reuses the entries cached
// from /api/tracker/urls (background.js already fetched these), so this
// needs no extra request. excludeUrl drops the entry currently being shown
// (viewing an already-tracked job shouldn't list itself as an "other" one).
const OTHER_APPS_MAX = 4;
function otherAppsAtCompany(entries, company, excludeUrl) {
  if (!company) return [];
  const c = company.toLowerCase();
  return entries.filter(e => e.company && e.company.toLowerCase() === c && e.url !== excludeUrl);
}

function otherAppsHtml(company, others) {
  if (!others.length) return '';
  const shown = others.slice(0, OTHER_APPS_MAX);
  const extra = others.length - shown.length;
  return `
    <div class="other-apps">
      <div class="other-apps-title">Also at ${esc(company)}</div>
      ${shown.map(e => `
        <div class="other-apps-item">
          <span class="other-apps-role">${esc(e.role || '(no role)')}</span>
          ${stageBadge(e.stage)}
        </div>
      `).join('')}
      ${extra > 0 ? `<div class="other-apps-more">+${extra} more</div>` : ''}
    </div>
  `;
}

function renderTracked(entry, entries) {
  const root = document.getElementById('root');
  const others = otherAppsAtCompany(entries, entry.company, entry.url);
  root.innerHTML = `
    <div class="company">${esc(entry.company)}</div>
    ${entry.role ? `<div class="role">${esc(entry.role)}</div>` : ''}
    <div class="meta">
      ${stageBadge(entry.stage)}
      <span class="date">${formatDate(entry.lastUpdate)}</span>
    </div>
    ${otherAppsHtml(entry.company, others)}
    <div class="btn-row">
      <button class="open-btn" id="open-tracker">Open Tracker</button>
      ${entry.notionPageId ? `<button class="notion-btn" id="open-notion">Notion</button>` : ''}
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

  const notionBtn = document.getElementById('open-notion');
  if (notionBtn) {
    notionBtn.addEventListener('click', async () => {
      notionBtn.disabled = true; // guard against a fast double-click opening two tabs
      // Open in a background tab (no visible tab switch); background.js
      // closes it once it's loaded and had a chance to fire the native-app
      // handoff — see closeTabWhenLoaded in background.js for why that can't
      // happen from here.
      const tab = await chrome.tabs.create({ url: notionPageUrl(entry.notionPageId), active: false });
      chrome.runtime.sendMessage({ type: 'closeTabWhenLoaded', tabId: tab.id });
      window.close();
    });
  }

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

function renderSaveForm(tabUrl, { role, company }, entries) {
  const root = document.getElementById('root');
  const others = otherAppsAtCompany(entries, company, tabUrl);
  root.innerHTML = `
    <div class="save-title">Save to Job Tracker</div>
    ${otherAppsHtml(company, others)}
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
    let pageHtmlTargeted = false;
    let embeddedJobUrl = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('no active tab');
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Clone an element, strip non-content noise, return innerHTML
          function extractClean(el) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll(
              'button, svg, img, input, select, textarea, script, style, form, ' +
              '[aria-hidden="true"], [class*="premium"], [class*="apply-btn"], [class*="footer"], ' +
              '[id*="apply-form"], [class*="apply-form"]'
            ).forEach(n => n.remove());
            return clone.innerHTML;
          }

          // Find a leaf element whose visible text exactly matches a pattern
          function findByText(re) {
            for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p,strong')) {
              const t = el.innerText?.trim();
              if (t && t.length < 50 && re.test(t) && el.children.length === 0) return el;
            }
            return null;
          }

          // Walk up from el until we find an ancestor with substantial text
          function contentParent(el, minLen = 400, maxLen = 15000) {
            let node = el.parentElement;
            while (node && node !== document.body) {
              const len = node.innerText?.trim().length || 0;
              if (len >= minLen && len <= maxLen) return node;
              node = node.parentElement;
            }
            return null;
          }

          // Detect a same-tab iframe embedding a known ATS's hosted job page —
          // many company career pages embed Ashby/Greenhouse/Lever/Workday this
          // way rather than linking straight to the ATS. Cross-origin iframe
          // *content* isn't reachable from here, but src is just an HTML
          // attribute (always readable), and it's a real, directly-fetchable
          // page the server can extract from independently.
          function findEmbeddedAtsIframeUrl() {
            const ATS_HOSTS = ['ashbyhq.com', 'greenhouse.io', 'lever.co', 'myworkday.com'];
            for (const f of document.querySelectorAll('iframe[src]')) {
              try {
                const host = new URL(f.src, location.href).hostname;
                // Proper subdomain check — host.endsWith(h) alone would also
                // match a lookalike like "evilashbyhq.com".
                if (ATS_HOSTS.some(h => host === h || host.endsWith('.' + h))) return f.src;
              } catch {}
            }
            return null;
          }
          const embeddedJobUrl = findEmbeddedAtsIframeUrl();

          const host = location.hostname;

          // Targeted = matched a known site/heading selector → trust it.
          // Untargeted = greedy whole-page fallback → the server should prefer a
          // clean JobPosting JSON-LD instead (career-site SPAs are full of chrome).
          const targeted = (html) => ({ html, targeted: true, embeddedJobUrl });

          // ---- LinkedIn ----
          if (host.includes('linkedin.com')) {
            const h = findByText(/^about the job$/i);
            if (h) {
              const c = contentParent(h);
              if (c) return targeted(extractClean(c));
            }
            for (const sel of ['.jobs-description__content', '.jobs-description', '#job-details']) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 200) return targeted(extractClean(el));
            }
          }

          // ---- Greenhouse ----
          if (host.includes('greenhouse.io') || host.includes('boards.greenhouse')) {
            const jd = document.querySelector('.job__description, .job-post--description, #app_body .posting-description');
            if (jd && jd.innerText.trim().length > 200) return targeted(extractClean(jd));
          }

          // ---- Lever ----
          if (host.includes('jobs.lever.co') || host.includes('lever.co')) {
            const el = document.querySelector('.posting-description, .section-wrapper');
            if (el && el.innerText.trim().length > 200) return targeted(extractClean(el));
          }

          // ---- Workday ----
          const workday = document.querySelector('[data-automation-id="jobPostingDescription"]');
          if (workday) return targeted(extractClean(workday));

          // ---- Ashby ----
          const ashby = document.querySelector('[class*="JobPosting_description"], [class*="jobPosting"]');
          if (ashby) return targeted(extractClean(ashby));

          // ---- Generic fallback ----
          // Find the heading that looks like a job description title, then grab its section
          const jobHeading = findByText(/^(about (this |the )?role|job description|responsibilities|the role)$/i);
          if (jobHeading) {
            const c = contentParent(jobHeading);
            if (c) return targeted(extractClean(c));
          }

          // Last resort: largest content block that isn't nav/chrome — flagged
          // untargeted so the server can prefer JSON-LD if the page has it.
          let best = null, bestLen = 0;
          for (const el of document.querySelectorAll('article, main, [role="main"], section')) {
            if (el.closest('nav, header, footer, aside')) continue;
            const len = el.innerText?.trim().length || 0;
            if (len > bestLen && len < 50000) { bestLen = len; best = el; }
          }
          return { html: best && bestLen > 200 ? extractClean(best) : '', targeted: false, embeddedJobUrl };
        },
      });
      pageHtml = result?.result?.html || '';
      pageHtmlTargeted = result?.result?.targeted || false;
      embeddedJobUrl = result?.result?.embeddedJobUrl || null;
    } catch { /* scripting not available on this page — server will re-fetch */ }

    try {
      const res = await fetch(`${API}/api/tracker/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: tabUrl, role: roleVal, company: companyVal, stage: stageVal, pageHtml, pageHtmlTargeted, embeddedJobUrl }),
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
      renderTracked(match, entries);
    } else {
      let info = extractJobInfo(tab.title || '', tab.url);
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readJobPostingJsonLd,
        });
        const jsonLd = result?.result;
        if (jsonLd) info = { role: capitalizeWords(jsonLd.role), company: jsonLd.company };
      } catch { /* scripting not available on this page — keep the title-based guess */ }
      renderSaveForm(tab.url, info, entries);
    }
  } catch (e) {
    document.getElementById('root').innerHTML = '<p class="loading" style="padding:14px">Error: ' + e.message + '</p>';
  }
}

init();
