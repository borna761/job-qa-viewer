// Shared between background.js (service worker, loaded via importScripts)
// and popup.js (loaded via a plain <script> tag before popup.js in
// popup.html) — both load this first. Kept as a classic, non-module script
// since neither loader uses a bundler.

// ---- URL normalisation ----
// Used to compare a tab's URL against a saved tracker entry's URL, ignoring
// superficial differences (a locale path prefix, a trailing slash, Workday's
// redundant location segment in its job-id path) that don't change which
// posting it actually is.
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/').replace(/\/$/, '');
    path = path.replace(/\/job\/[^/]+\/(.*_r\d+[^/]*)/i, '/job/$1');
    return (u.hostname + path).toLowerCase();
  } catch { return null; }
}

// ---- Title-based role/company fallback ----
// Used when there's no richer signal available: background.js only ever has
// this (no DOM access, no user gesture for scripting.executeScript — see its
// own comment on guessCompanyFromTab), and popup.js falls back to it when
// there's no JobPosting JSON-LD or it hasn't loaded into the DOM yet.
// Always returns {role, company}; company is '' when no pattern matched.
function parseJobTitleFallback(pageTitle, tabUrl) {
  let host = null;
  try { host = new URL(tabUrl).hostname.replace(/^www\./, ''); } catch {}

  const title = (pageTitle || '')
    .replace(/\s*[-|]\s*(LinkedIn|Greenhouse|Lever|Workday|Indeed|Glassdoor|Jobs|Careers)[^|]*$/i, '')
    .trim();
  if (!title) return { role: '', company: '' };

  const atMatch = title.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: atMatch[1].trim(), company: atMatch[2].trim() };

  // "Role @ Company" — the actual format Ashby-hosted job page titles use.
  const atSymbolMatch = title.match(/^(.+?)\s*@\s*(.+)$/);
  if (atSymbolMatch) return { role: atSymbolMatch[1].trim(), company: atSymbolMatch[2].trim() };

  const pipeMatch = title.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { role: pipeMatch[1].trim(), company: pipeMatch[2].trim() };

  // "Role - Company[ - Location]" — Indeed's own title convention. Gated to
  // Indeed specifically: unlike "at"/"@"/"|", a bare " - " is common in all
  // kinds of unrelated page titles (video titles, news headlines, ...), so
  // applying this on every tab would fabricate a bogus company guess for
  // any non-job page with a dash in its title.
  if (host && /(^|\.)indeed\.com$/.test(host)) {
    const dashMatch = title.match(/^(.+?)\s+-\s+(.+)$/);
    if (dashMatch) return { role: dashMatch[1].trim(), company: dashMatch[2].trim() };
  }

  return { role: title, company: '' };
}
