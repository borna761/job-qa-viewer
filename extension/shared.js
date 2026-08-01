// Shared between background.js (service worker, loaded via importScripts)
// and popup.js (loaded via a plain <script> tag before popup.js in
// popup.html) — both load this first. Kept as a classic, non-module script
// since neither loader uses a bundler.

// ---- Stage colors ----
// Canonical per-stage color: background.js's toolbar-icon fill uses these
// directly, popup.js's badge pill uses them as text color (pairing each
// with its own locally-defined pastel background — that pairing is a
// popup-only design choice with no icon equivalent, so it stays local).
// These used to be two independently-chosen sets that agreed on 2 of 6
// stages and disagreed on the other 4. Kept this (darker/more muted) set
// as canonical rather than the brighter one background.js used to have:
// checked as small badge text against popup.js's pastel backgrounds, the
// brighter set fails WCAG AA's 4.5:1 small-text contrast threshold for 3 of
// the 4 differing stages (Stale drops to 2.3:1) — it was tuned for solid-
// fill visibility on toolbar chrome, not text-on-pastel contrast, and
// darker jewel tones read fine as an icon fill either way.
const STAGE_COLOR = {
  'Interested':  '#0891b2',
  'Applied':     '#1d4ed8',
  'Interviews':  '#5b21b6',
  'Stale':       '#6b7280',
  'Turned Down': '#c2410c',
  'Rejected':    '#b91c1c',
};

// ---- Known ATS hosts ----
// Hosts whose iframe embeds or direct URLs are treated as a real,
// independently-fetchable job page rather than page chrome. Keep in sync
// with lib/notionHtml.js's EMBEDDABLE_ATS_HOSTS — that one can't literally
// share this file (server-side Node vs. extension, no shared module system
// between them), so it's a manually-kept-parallel list; each file points at
// the other via comment.
const KNOWN_ATS_HOSTS = ['ashbyhq.com', 'greenhouse.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com'];

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
// knownHost is optional — pass it when the caller already parsed tabUrl's
// hostname (background.js does, for its own ATS-host checks) to skip a
// redundant re-parse here; callers without one (popup.js) can omit it.
function parseJobTitleFallback(pageTitle, tabUrl, knownHost) {
  let host = knownHost ?? null;
  if (host === null) {
    try { host = new URL(tabUrl).hostname.replace(/^www\./, ''); } catch {}
  }

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
