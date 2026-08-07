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
const KNOWN_ATS_HOSTS = ['ashbyhq.com', 'greenhouse.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com', 'icims.com'];

// ---- Text case helpers ----
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

// ---- Loose company-name matching ----
// A title/hostname-derived guess ("acmewidgets") often won't equal the
// company's saved display name ("Acme") exactly, so this is a substring
// check in either direction. A minimum length guard avoids trivial false
// positives from very short names.
function companyNamesLooselyMatch(a, b) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 3) return false;
  return longer.includes(shorter);
}

// ---- URL-pattern-based extraction for known ATS platforms ----
// Consolidates the company (and sometimes role) that can be read directly
// from a known ATS's URL shape — used by both background.js's toolbar-badge
// guess (which only keeps .company) and popup.js's save-form fallback
// (which uses both). Returns {role, company} (role is null when it isn't
// derivable from the URL alone) or null when the URL doesn't match a known
// ATS pattern at all — callers fall through to parseJobTitleFallback either
// way.
function extractFromKnownAtsUrl(pageTitle, tabUrl) {
  let u;
  try { u = new URL(tabUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');

  // Shared by the Workday and generic-/job/ branches below: the segment
  // after /job/ is a human-readable slug (Workday-style: "Product-Manager")
  // on both. Some ATS platforms (Loxo, e.g. acme.app.loxo.co/job/{base64id})
  // put an opaque base64 ID there instead — titleCase()-ing that produces
  // garbage instead of a real role. "=" padding is a reliable base64 tell
  // that never appears in an actual slug. Loxo has its own dedicated host
  // check below that returns before ever reaching either /job/ branch, so
  // this guard is mostly relevant for other opaque-ID platforms sharing the
  // same URL shape.
  // The trailing "_<requisition id>" suffix isn't always "_R<digits>" —
  // some tenants use a bespoke alphanumeric code instead (observed: a real
  // posting whose ID was digits-then-letters-then-digits, e.g. "_12CD34567",
  // plus a "-2" repost/revision suffix, which the old "_[Rr]\d+"-only
  // pattern left stuck onto the role). Workday's own convention reserves
  // "_" in this segment for the requisition ID, never for role text, so
  // it's safe to strip any trailing "_<code containing a digit>" here
  // regardless of its exact shape.
  const roleFromJobSlug = () => {
    const m = u.pathname.match(/\/job\/(?:[^/]+\/)?([^/]+?)(?:_[A-Za-z0-9]*\d[A-Za-z0-9]*(?:-\d+)?)?(?:\/|$)/);
    return (m && !m[1].includes('=')) ? titleCase(m[1]) : null;
  };

  // Hosted ATS boards that put the company slug directly in the path —
  // e.g. jobs.lever.co/acme/…, jobs.ashbyhq.com/acme/…,
  // boards.greenhouse.io/acme/jobs/1234 (or job-boards.greenhouse.io),
  // careers.kula.ai/acme/…. These never match the /job/ pattern below
  // (Lever/Ashby/Kula have no "job" segment at all, and Greenhouse uses
  // "/jobs/" — plural, so it doesn't match "/job/" either), so without this
  // they fell through to the much less reliable title-guessing and
  // typically returned no company at all.
  if (/(^|\.)(lever\.co|ashbyhq\.com|greenhouse\.io|kula\.ai)$/.test(host)) {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (slug) {
      // Kula.ai's title is "Role - Company" where Role itself can contain
      // internal dashes (e.g. "Staff Engineer - Platform - Acme"), so a
      // blind first/last " - " split isn't reliable. Cross-check the URL
      // slug against the title's trailing dash segment (loose, case/
      // punctuation-insensitive) to recover a clean role too when possible
      // — the company itself is trustworthy from the URL either way, with
      // or without a title to corroborate it.
      if (/(^|\.)kula\.ai$/.test(host)) {
        const dashParts = (pageTitle || '').split(/\s+-\s+/);
        const lastPart = dashParts[dashParts.length - 1];
        if (lastPart && dashParts.length > 1 &&
            lastPart.toLowerCase().replace(/[^a-z0-9]/g, '') === slug.toLowerCase().replace(/[^a-z0-9]/g, '')) {
          const role = dashParts.slice(0, -1).join(' - ').trim();
          if (role) return { role, company: lastPart.trim() };
        }
      }
      return { role: null, company: titleCase(slug) };
    }
  }

  // Workday tenants — acme.myworkdayjobs.com (the real-world form, often
  // with a region label too: acme.wd1.myworkdayjobs.com) or the shorter
  // acme.myworkday.com. Either way company is the first hostname label,
  // not the label before the TLD — unlike the company-owned-domain case
  // below, there's no "careers." subdomain prefix to skip past. Anchored
  // the same way as the lever/ashby/greenhouse check above — a bare
  // .endsWith() would also match a lookalike like "evilmyworkdayjobs.com".
  // Workday's own URLs always carry the /job/{slug} path this codebase
  // already recognizes (that's literally the platform roleFromJobSlug was
  // originally written for), so pull role from there too rather than
  // leaving it null and losing a signal the URL already provides.
  if (/(^|\.)(myworkdayjobs\.com|myworkday\.com)$/.test(host))
    return { role: roleFromJobSlug(), company: titleCase(host.split('.')[0]) };

  // Loxo tenants — acme.app.loxo.co: same tenant-subdomain shape as
  // Workday above, so the same "first label" extraction applies.
  if (/(^|\.)app\.loxo\.co$/.test(host))
    return { role: null, company: titleCase(host.split('.')[0]) };

  // Rippling ATS — ats.rippling.com/{locale}/{company}/jobs/{uuid}, where
  // the locale segment (e.g. en-CA) is often but not always present. The
  // page title is just the bare role text with no company in it at all —
  // company comes entirely from the URL, role from the raw title.
  if (/(^|\.)ats\.rippling\.com$/.test(host)) {
    const path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/');
    const slug = path.split('/').filter(Boolean)[0];
    if (slug) return { role: pageTitle ? pageTitle.trim() : null, company: titleCase(slug) };
  }

  // Generic /job/ path with a human-readable slug — custom domains that
  // aren't a known ATS (careers.zenith.com/job/Product-Manager).
  const genericRole = roleFromJobSlug();
  if (genericRole) {
    // Take the label just before the TLD, not always the first label —
    // "careers.zenith.com" is the company's own domain but the company
    // name is "zenith", not "careers".
    const parts = host.split('.');
    const company = titleCase(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
    return { role: genericRole, company };
  }

  return null;
}

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
    .replace(/\s*[-|]\s*(LinkedIn|Greenhouse|Lever|Workday|Indeed|Glassdoor|Jobs|Careers|Wellfound)[^|]*$/i, '')
    .trim();
  if (!title) return { role: '', company: '' };

  // Some sites (Wellfound: "Role at Company • Boston • Toronto • Remote
  // (Work from Home)") tack extra "• Location • Location • WorkType" tags
  // onto the end of the company segment — none of that is the company name.
  // "•" is never legitimately part of a company name in any of these title
  // conventions, so it's safe to cut there regardless of which pattern below
  // matched.
  const cleanCompany = s => s.split(/\s*•\s*/)[0].trim();

  const atMatch = title.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: atMatch[1].trim(), company: cleanCompany(atMatch[2]) };

  // "Role @ Company" — the actual format Ashby-hosted job page titles use.
  const atSymbolMatch = title.match(/^(.+?)\s*@\s*(.+)$/);
  if (atSymbolMatch) return { role: atSymbolMatch[1].trim(), company: cleanCompany(atSymbolMatch[2]) };

  const pipeMatch = title.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { role: pipeMatch[1].trim(), company: cleanCompany(pipeMatch[2]) };

  // "Role - Company[ - Location]" — Indeed's own title convention. Gated to
  // Indeed specifically: unlike "at"/"@"/"|", a bare " - " is common in all
  // kinds of unrelated page titles (video titles, news headlines, ...), so
  // applying this on every tab would fabricate a bogus company guess for
  // any non-job page with a dash in its title.
  if (host && /(^|\.)indeed\.com$/.test(host)) {
    const dashMatch = title.match(/^(.+?)\s+-\s+(.+)$/);
    if (dashMatch) return { role: dashMatch[1].trim(), company: cleanCompany(dashMatch[2]) };
  }

  return { role: title, company: '' };
}

// ---- Full role/company resolution ----
// Composes extractFromKnownAtsUrl + parseJobTitleFallback the way popup.js's
// save form needs (both role and company). Precedence: a cross-checked or
// definitionally-company-less URL match (Kula.ai's title cross-check,
// Rippling) is high-confidence — trust it outright. Otherwise prefer a
// company the title itself already yielded (e.g. a clean "Role | Company"
// match) over a bare URL slug — a raw slug like "acme" is a worse guess
// than a title-derived "Acme Co." when both are available. The URL-based
// company (Workday/Loxo/Lever/Ashby/Greenhouse/Rippling, or Kula.ai when its
// title didn't cross-check) only wins when title parsing found nothing at
// all — this used to be popup.js's own extractJobInfo, and that ordering is
// exactly why: an earlier version that tried the URL first regressed the
// Loxo case (a real posting whose title had a clean "Role | Company" but
// whose URL only offers a lowercase slug) before this precedence was fixed.
function extractJobInfo(pageTitle, tabUrl) {
  let host = null;
  try { host = new URL(tabUrl).hostname.replace(/^www\./, ''); } catch {}

  const known = extractFromKnownAtsUrl(pageTitle, tabUrl);
  if (known && known.role && known.company) return known;

  const fallback = parseJobTitleFallback(pageTitle, tabUrl, host);
  if (fallback.company) return fallback;
  if (known && known.company) return { role: fallback.role, company: known.company };
  return fallback;
}

// Company-only variant for background.js's toolbar-badge guess, which has
// no DOM access to a page title beyond tab.title (see its own comment on
// guessCompanyFromTab for why). Unlike extractJobInfo above, this always
// prefers the URL-derived company when a known ATS host matches — no title
// fallback to weigh it against here, since role isn't needed at all.
function guessCompanyFromTab(title, tabUrl) {
  let host = null;
  try { host = new URL(tabUrl).hostname.replace(/^www\./, ''); } catch {}

  const known = extractFromKnownAtsUrl(title, tabUrl);
  if (known && known.company) return known.company;
  const { company } = parseJobTitleFallback(title, tabUrl, host);
  return company || null;
}

// Exported for node:test coverage (test/shared.test.js) — no-op in the
// extension itself, where this file is loaded as a plain <script>/
// importScripts and `module` doesn't exist.
if (typeof module !== 'undefined') {
  module.exports = {
    STAGE_COLOR, KNOWN_ATS_HOSTS,
    capitalizeWords, titleCase, companyNamesLooselyMatch,
    extractFromKnownAtsUrl, normalizeUrl, parseJobTitleFallback,
    extractJobInfo, guessCompanyFromTab,
  };
}
