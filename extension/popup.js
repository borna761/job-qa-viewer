const API = 'http://localhost:3456';

// Pastel companion background per stage — pairs with STAGE_COLOR (from
// shared.js) as the badge's text color. This bg pairing is a popup-only
// design choice with no toolbar-icon equivalent, so it has no shared source.
const STAGE_BG = {
  'Interested':  '#ecfeff',
  'Applied':     '#dbeafe',
  'Interviews':  '#ede9fe',
  'Stale':       '#f3f4f6',
  'Turned Down': '#fff7ed',
  'Rejected':    '#fee2e2',
};

const SAVE_STAGES = [
  { label: 'Not applied', value: 'Not applied' },
  { label: 'Active',      value: 'Active'      },
];

// normalizeUrl, parseJobTitleFallback, STAGE_COLOR, KNOWN_ATS_HOSTS: see
// shared.js (loaded before this file)

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

function stageBadge(stage) {
  const bg = STAGE_BG[stage] || '#f3f4f6';
  const color = STAGE_COLOR[stage] || '#6b7280';
  return `<span class="stage-badge" style="background:${bg};color:${color}">${esc(stage)}</span>`;
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
//
// Returns {role, company} for a full JobPosting match. Falls back to
// {company} alone (no role) when there's no JobPosting node but there is an
// Organization one — common on WordPress/Yoast-SEO-powered career pages,
// which expose a site-wide @graph (WebPage/WebSite/Organization) instead of
// job-specific schema, sometimes not even for the current route (observed on
// a client-rendered ATS page whose JSON-LD still described an unrelated
// "Privacy Policy" WebPage — the Organization name was still trustworthy,
// the WebPage wasn't). An Organization node is common on almost any page
// though, so this is gated to URLs that look like a job posting — using it
// unconditionally would fabricate a company guess on completely unrelated
// pages. The caller keeps its own title-derived role in this case.
function readJobPostingJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  let orgName = null;
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
      if (node && node['@type'] === 'Organization' && node.name) orgName = node.name;
    }
  }
  if (orgName && /\/(jobs?|careers?)(\/|$)/i.test(location.pathname)) return { company: orgName };
  return null;
}

// Fallback when there's no JobPosting JSON-LD: guess role/company from the
// tab title. Unreliable on career sites that render the title as a
// breadcrumb ("Job postings | Role | Location | Company | site.com") — the
// JSON-LD path above is preferred whenever it's available.
function extractJobInfo(pageTitle, tabUrl) {
  try {
    const u = new URL(tabUrl);
    const host = u.hostname.replace(/^www\./, '');

    // Kula.ai tenants — {subdomain}.kula.ai/{company}/{jobId}/: no JobPosting
    // JSON-LD at all, and the title is "Role - Company" where Role itself
    // can contain internal dashes (e.g. "Staff Engineer - Platform - Acme"),
    // so a blind first/last " - " split isn't reliable. Instead: confirm the
    // URL's company slug matches the title's trailing dash segment (loose,
    // case/punctuation-insensitive compare), then use the title's own text
    // as company — its real casing — and strip it off the end for role,
    // sidestepping the ambiguity entirely.
    if (/(^|\.)kula\.ai$/.test(host)) {
      const slug = u.pathname.split('/').filter(Boolean)[0];
      const dashParts = (pageTitle || '').split(/\s+-\s+/);
      const lastPart = dashParts[dashParts.length - 1];
      if (slug && lastPart && dashParts.length > 1 &&
          lastPart.toLowerCase().replace(/[^a-z0-9]/g, '') === slug.toLowerCase().replace(/[^a-z0-9]/g, '')) {
        const role = dashParts.slice(0, -1).join(' - ').trim();
        if (role) return { role, company: lastPart.trim() };
      }
    }

    // Rippling ATS — ats.rippling.com/{locale}/{company}/jobs/{uuid}, where
    // the locale segment (e.g. en-CA) is often but not always present. The
    // page title is just the bare role text with no company in it at all
    // (unlike Kula.ai above, there's nothing to disambiguate) — company
    // comes entirely from the URL.
    if (/(^|\.)ats\.rippling\.com$/.test(host)) {
      const path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/');
      const slug = path.split('/').filter(Boolean)[0];
      if (slug && pageTitle) return { role: pageTitle.trim(), company: titleCase(slug) };
    }

    const m = u.pathname.match(/\/job\/(?:[^/]+\/)?([^/]+?)(?:_[Rr]\d+)?(?:\/|$)/);
    // This heuristic assumes the segment after /job/ is a human-readable
    // slug (Workday-style: "Product-Manager"). Some ATS platforms (Loxo,
    // e.g. acme.app.loxo.co/job/{base64id}) instead put an opaque base64
    // ID there — titleCase()-ing that produces garbage instead of a real
    // role. "=" padding is a reliable base64 tell that never appears in
    // an actual slug, so bail out and fall through to the title-based
    // match below instead.
    if (m && !m[1].includes('=')) {
      const role = titleCase(m[1]);
      const company = titleCase(u.hostname.replace(/^www\./, '').split('.')[0]);
      if (role) return { role, company };
    }
  } catch {}

  return parseJobTitleFallback(pageTitle, tabUrl);
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
// Compared via normalizeUrl, not exact string equality — two saves of the
// same posting can differ superficially (trailing slash, tracking params)
// while still being the same application, exactly what normalizeUrl is
// already used elsewhere in this file to collapse.
const OTHER_APPS_MAX = 4;
function otherAppsAtCompany(entries, company, excludeUrl) {
  if (!company) return [];
  const c = company.toLowerCase();
  const excludeKey = normalizeUrl(excludeUrl);
  return entries.filter(e =>
    e.company && e.company.toLowerCase() === c && normalizeUrl(e.url) !== excludeKey);
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
  root.innerHTML = `
    <div class="save-title">Save to Job Tracker</div>
    <div id="other-apps-container">${otherAppsHtml(company, otherAppsAtCompany(entries, company, tabUrl))}</div>
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

  // Keep the "Also at X" box in sync as the user edits Company — it's
  // computed from the auto-detected value at render time, which can be
  // wrong or blank; without this it would silently go stale the moment
  // someone corrects the field.
  const companyInput = document.getElementById('inp-company');
  const otherAppsContainer = document.getElementById('other-apps-container');
  companyInput.addEventListener('input', () => {
    const liveCompany = companyInput.value.trim();
    otherAppsContainer.innerHTML = otherAppsHtml(liveCompany, otherAppsAtCompany(entries, liveCompany, tabUrl));
  });

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
      // KNOWN_ATS_HOSTS (shared.js) is passed in via args rather than
      // hardcoded inside func below — args is the sanctioned way to get data
      // into an injected function without a closure over the outer scope
      // (which chrome.scripting.executeScript otherwise forbids). Keeps
      // this list defined in exactly one place in the extension, instead of
      // a second hardcoded copy buried inside the injected closure.
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [KNOWN_ATS_HOSTS],
        func: (atsHosts) => {
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
            for (const f of document.querySelectorAll('iframe[src]')) {
              try {
                const host = new URL(f.src, location.href).hostname;
                // Proper subdomain check — host.endsWith(h) alone would also
                // match a lookalike like "evilashbyhq.com".
                if (atsHosts.some(h => host === h || host.endsWith('.' + h))) return f.src;
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

          // ---- Indeed ----
          // Indeed blocks server-side fetches with a Cloudflare challenge (so
          // fetchAndExtractBlocks's re-fetch fallback in server.js never sees
          // real content), which makes a targeted grab here — running in the
          // user's own already-past-the-challenge browser session — the only
          // reliable source for the description on this site.
          if (host.includes('indeed.com')) {
            const jd = document.querySelector('#jobDescriptionText');
            if (jd && jd.innerText.trim().length > 200) return targeted(extractClean(jd));
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
        if (jsonLd?.role && jsonLd?.company) {
          info = { role: capitalizeWords(jsonLd.role), company: jsonLd.company };
        } else if (jsonLd?.company && !info.company) {
          // Organization-only fallback (no JobPosting node) — fill in just
          // the company, keep the title-derived role since there's nothing
          // better to replace it with.
          info = { ...info, company: jsonLd.company };
        }
      } catch { /* scripting not available on this page — keep the title-based guess */ }
      renderSaveForm(tab.url, info, entries);
    }
  } catch (e) {
    document.getElementById('root').innerHTML = '<p class="loading" style="padding:14px">Error: ' + e.message + '</p>';
  }
}

init();
