// Tests for extension/shared.js — the pure, chrome/DOM-free parsing logic
// shared between background.js's toolbar-badge guess and popup.js's
// save-form fallback. Each case here is a regression lock for a real bug
// found and fixed via live testing against an actual reported posting;
// see the commit history for the original report each one traces back to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  capitalizeWords, titleCase, companyNamesLooselyMatch, stripLeadingOrgCode,
  extractFromKnownAtsUrl, normalizeUrl, parseJobTitleFallback,
  extractJobInfo, guessCompanyFromTab,
} = require('../extension/shared');

test('capitalizeWords capitalizes each word without disturbing punctuation', () => {
  assert.equal(capitalizeWords('acme corp'), 'Acme Corp');
  assert.equal(capitalizeWords('acme-widgets'), 'Acme-Widgets');
});

test('capitalizeWords uppercases letter-digit-letter acronyms (b2b, b2c, p2p)', () => {
  assert.equal(capitalizeWords('b2b platform'), 'B2B Platform');
  assert.equal(capitalizeWords('b2c app'), 'B2C App');
});

test('titleCase turns a dash/underscore slug into spaced Title Case', () => {
  assert.equal(titleCase('acme-widgets'), 'Acme Widgets');
  assert.equal(titleCase('acme_widgets'), 'Acme Widgets');
  assert.equal(titleCase('acme'), 'Acme');
});

test('companyNamesLooselyMatch: substring either direction, case/punctuation-insensitive', () => {
  assert.equal(companyNamesLooselyMatch('acmewidgets', 'Acme Widgets'), true);
  assert.equal(companyNamesLooselyMatch('Acme Widgets', 'acmewidgets'), true);
  assert.equal(companyNamesLooselyMatch('Acme', 'Acme Widgets'), true);
});

test('companyNamesLooselyMatch: guards against trivial short-name false positives', () => {
  assert.equal(companyNamesLooselyMatch('Co', 'Acme Co'), false); // "co" < 3 chars
  assert.equal(companyNamesLooselyMatch('Acme', 'Northwind'), false);
  assert.equal(companyNamesLooselyMatch('', 'Acme'), false);
  assert.equal(companyNamesLooselyMatch('Acme', null), false);
});

test('companyNamesLooselyMatch: a short tracked company name doesn\'t match merely because its letters appear mid-word in an unrelated longer name', () => {
  // Real case that triggered this: a short tracked company name happened to
  // be a literal substring of an ordinary word embedded in a much longer,
  // completely unrelated guessed company name — the old raw-substring check
  // (min length 3) matched it, showing an unrelated company's tracked
  // status on this page. "Aria"/"Bulgaria" reproduces the same shape: "aria"
  // is a genuine substring of "bulgaria" but never occurs there as a whole
  // word.
  assert.equal(companyNamesLooselyMatch('Aria', "Bulgaria Imports Ltd"), false);
  // Still matches when the short name IS a whole word within the longer one.
  assert.equal(companyNamesLooselyMatch('Aria', 'Aria Robotics'), true);
});

// ---- extractFromKnownAtsUrl ----

test('extractFromKnownAtsUrl: Lever/Ashby/Greenhouse use the company-as-first-path-segment shape', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    { role: null, company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://jobs.ashbyhq.com/acme/abc-123'),
    { role: null, company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://boards.greenhouse.io/acme/jobs/1234567'),
    { role: null, company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://job-boards.greenhouse.io/acme/jobs/1234567'),
    { role: null, company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Kula.ai cross-checks the URL slug against the title\'s trailing dash segment', () => {
  // Role itself contains an internal dash — a blind first/last split would
  // misplace "Platform" into either role or company.
  assert.deepEqual(
    extractFromKnownAtsUrl('Staff Engineer - Platform - Acme', 'https://careers.kula.ai/acme/35411'),
    { role: 'Staff Engineer - Platform', company: 'Acme' },
  );
  // Simple 2-part title still works.
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Manager - Acme', 'https://careers.kula.ai/acme/123'),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Kula.ai falls back to slug-only when the title doesn\'t corroborate it', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Manager - Northwind', 'https://careers.kula.ai/acme/123'),
    { role: null, company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Manager', 'https://careers.kula.ai/acme/123'), // no dash at all
    { role: null, company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://careers.kula.ai/acme/123'), // no title at all
    { role: null, company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Workday tenants pull role from the /job/ slug too, not just company', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Product-Manager_R123'),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Workday tenant with no /job/ slug in the path still gets company, role null', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://acme.myworkday.com/careers/openings'),
    { role: null, company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Workday requisition IDs that don\'t start with "R" still get stripped from the role', () => {
  // Not every tenant's requisition ID follows the "_R<digits>" shape the
  // original regex assumed — some are a bespoke alphanumeric code (here,
  // digits-then-letters-then-digits) with a trailing "-<n>" repost/revision
  // suffix. A real posting had this exact shape and the old regex left the
  // whole ID stuck onto the role instead of stripping it.
  assert.deepEqual(
    extractFromKnownAtsUrl(
      null,
      'https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Staff-Engineer---Developer-Platform_12CD34567-2',
    ),
    { role: 'Staff Engineer   Developer Platform', company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: a bare trailing "_<digit>" is kept as role text, not mistaken for a requisition ID', () => {
  // Real requisition IDs are always more than a single character (e.g.
  // "R123", "26WD97546") — a lone trailing "_2" is far more likely to be
  // part of the role itself (a level number) than an ID, so the strip
  // regex requires at least 2 characters in the code before it fires.
  assert.deepEqual(
    extractFromKnownAtsUrl(
      null,
      'https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Software-Engineer_2',
    ),
    { role: 'Software Engineer 2', company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Workday host match is anchored, not a bare suffix check', () => {
  // A naive .endsWith('myworkdayjobs.com') would also match this lookalike.
  // Path deliberately has no /job/ segment, so this isolates the Workday
  // check itself rather than also exercising the separate generic-/job/
  // fallback (which would legitimately match this same host on its own).
  assert.equal(extractFromKnownAtsUrl(null, 'https://evilmyworkdayjobs.com/careers/openings'), null);
});

test('extractFromKnownAtsUrl: Loxo tenants (acme.app.loxo.co)', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://acme.app.loxo.co/job/OTk5OTktZmFrZWpvYmlkZmFrZWpvYg=='),
    { role: null, company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Rippling strips an optional locale prefix before the company segment', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
    { role: 'Product Owner', company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Owner', 'https://ats.rippling.com/acme/jobs/bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
    { role: 'Product Owner', company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: generic /job/ path with a human-readable slug', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://careers.zenith.com/job/Product-Manager'),
    { role: 'Product Manager', company: 'Zenith' },
  );
  // Company is the label just before the TLD, not always the first label —
  // "careers.zenith.com" is the company's own domain but the company name
  // is "zenith", not "careers".
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://zenith.com/job/Product-Manager'),
    { role: 'Product Manager', company: 'Zenith' },
  );
});

test('extractFromKnownAtsUrl: generic /job/ rejects an opaque base64 ID instead of mangling it into a role', () => {
  // A base64 ID (Loxo-style, but hitting the generic path rather than the
  // dedicated Loxo host check above) contains "=" padding, which never
  // appears in a real human-readable slug.
  assert.equal(
    extractFromKnownAtsUrl(null, 'https://careers.example.com/job/OTk5OTktZmFrZWpvYmlkZmFrZWpvYg=='),
    null,
  );
});

test('extractFromKnownAtsUrl: returns null for a host that matches no known ATS pattern', () => {
  assert.equal(extractFromKnownAtsUrl('Product Manager', 'https://www.youtube.com/watch?v=xyz'), null);
});

test('extractFromKnownAtsUrl: returns null for a malformed URL instead of throwing', () => {
  assert.equal(extractFromKnownAtsUrl('Product Manager', 'not-a-url'), null);
});

// ---- parseJobTitleFallback ----

test('parseJobTitleFallback: "Role at Company" (LinkedIn-style)', () => {
  assert.deepEqual(
    parseJobTitleFallback('Product Manager at Acme Corp', 'https://www.linkedin.com/jobs/view/12345'),
    { role: 'Product Manager', company: 'Acme Corp' },
  );
});

test('parseJobTitleFallback: "Role @ Company" (Ashby-style)', () => {
  assert.deepEqual(
    parseJobTitleFallback('Product Manager @ Acme', 'https://jobs.ashbyhq.com/acme/xyz'),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('parseJobTitleFallback: "Role | Company"', () => {
  assert.deepEqual(
    parseJobTitleFallback('Product Manager | Acme', 'https://example.com/careers/1'),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('parseJobTitleFallback: Indeed\'s "Role - Company - Location" dash convention, gated to indeed.com', () => {
  assert.deepEqual(
    parseJobTitleFallback('Senior Product Manager - Acme Corp - Toronto, ON | Indeed.com', 'https://ca.indeed.com/viewjob?jk=abc'),
    { role: 'Senior Product Manager', company: 'Acme Corp - Toronto, ON' },
  );
});

test('parseJobTitleFallback: does not fabricate a company from a bare dash on a non-Indeed page', () => {
  assert.deepEqual(
    parseJobTitleFallback('Python Tutorial - Learn Fast', 'https://www.youtube.com/watch?v=xyz'),
    { role: 'Python Tutorial - Learn Fast', company: '' },
  );
  assert.deepEqual(
    parseJobTitleFallback('Fed raises rates - Reuters', 'https://www.reuters.com/markets/x'),
    { role: 'Fed raises rates - Reuters', company: '' },
  );
});

test('parseJobTitleFallback: strips trailing "• Location • WorkType" tags Wellfound adds after the company', () => {
  assert.deepEqual(
    parseJobTitleFallback(
      'Senior Product Manager at Acme • Boston • Toronto • Remote (Work from Home) | Wellfound',
      'https://wellfound.com/jobs/4544919-senior-product-manager',
    ),
    { role: 'Senior Product Manager', company: 'Acme' },
  );
});

test('parseJobTitleFallback: known site-name suffixes get stripped before matching', () => {
  assert.deepEqual(
    parseJobTitleFallback('Product Manager at Acme - Greenhouse', 'https://example.com/x'),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('parseJobTitleFallback: "Role - Careers At Company" (hrmdirect-style) splits cleanly, unlike the generic suffix strip', () => {
  // Regression: the generic site-suffix stripper used to treat "Careers"
  // the same as a real platform brand name (LinkedIn, Indeed, ...) and
  // strip it plus everything after it — including the actual company name
  // that followed "Careers At" on a real reported posting.
  assert.deepEqual(
    parseJobTitleFallback('Product Engineer - Careers At Acme', 'https://acme.hrmdirect.com/x'),
    { role: 'Product Engineer', company: 'Acme' },
  );
  assert.deepEqual(
    parseJobTitleFallback('Senior Engineer - Jobs At Acme', 'https://acme.hrmdirect.com/x'),
    { role: 'Senior Engineer', company: 'Acme' },
  );
});

test('parseJobTitleFallback: a bare trailing "- Careers"/"- Jobs" with nothing after is still stripped cleanly', () => {
  assert.deepEqual(
    parseJobTitleFallback('Product Manager - Careers', 'https://example.com/x'),
    { role: 'Product Manager', company: '' },
  );
  assert.deepEqual(
    parseJobTitleFallback('Product Manager | Jobs', 'https://example.com/x'),
    { role: 'Product Manager', company: '' },
  );
});

test('parseJobTitleFallback: "Role — Company Careers" (em-dash, trailing "Careers" after the company) splits cleanly', () => {
  // Regression: a real posting's title used an em-dash ("—"), not a plain
  // hyphen, as the separator — every dash-aware pattern only recognized
  // ASCII "-", so the whole title fell through every pattern unmatched,
  // landing on the final fallback (role = the entire unparsed title,
  // company = ''). This is the mirror image of the "Careers At Company"
  // pattern above: here "Careers" trails the company instead of leading it.
  assert.deepEqual(
    parseJobTitleFallback('Senior Product Manager, Platform — Acme Careers', 'https://example.com/x'),
    { role: 'Senior Product Manager, Platform', company: 'Acme' },
  );
});

test('parseJobTitleFallback: em-dash and en-dash work everywhere a plain hyphen already did', () => {
  // Same known-site-suffix and "Careers At" patterns as the tests above,
  // just with an em-dash/en-dash separator instead of a plain hyphen.
  assert.deepEqual(
    parseJobTitleFallback('Product Manager at Acme — Greenhouse', 'https://example.com/x'),
    { role: 'Product Manager', company: 'Acme' },
  );
  assert.deepEqual(
    parseJobTitleFallback('Product Engineer – Careers At Acme', 'https://acme.hrmdirect.com/x'),
    { role: 'Product Engineer', company: 'Acme' },
  );
});

test('parseJobTitleFallback: empty/falsy title returns empty role and company', () => {
  assert.deepEqual(parseJobTitleFallback('', 'https://example.com/x'), { role: '', company: '' });
  assert.deepEqual(parseJobTitleFallback(null, 'https://example.com/x'), { role: '', company: '' });
});

test('parseJobTitleFallback: no pattern matches falls back to the whole title as role', () => {
  assert.deepEqual(
    parseJobTitleFallback('Just A Plain Title With No Markers', 'https://example.com/x'),
    { role: 'Just A Plain Title With No Markers', company: '' },
  );
});

test('parseJobTitleFallback: accepts a pre-parsed host to skip re-parsing tabUrl', () => {
  const withHost = parseJobTitleFallback('Role - Company - Loc | Indeed.com', 'https://ca.indeed.com/x', 'ca.indeed.com');
  const withoutHost = parseJobTitleFallback('Role - Company - Loc | Indeed.com', 'https://ca.indeed.com/x');
  assert.deepEqual(withHost, withoutHost);
});

// ---- normalizeUrl ----

test('normalizeUrl strips a locale path prefix, trailing slash, and lowercases', () => {
  assert.equal(normalizeUrl('https://Example.com/en-US/Jobs/123/'), 'example.com/jobs/123');
});

test('normalizeUrl collapses Workday\'s redundant location segment in the job-id path', () => {
  assert.equal(
    normalizeUrl('https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Toronto-ON/Product-Manager_R1234'),
    normalizeUrl('https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Product-Manager_R1234'),
  );
});

test('normalizeUrl collapses Workday\'s redundant location segment even when the requisition id isn\'t "_R<digits>"', () => {
  // Some Workday tenants use a bespoke requisition id shape instead of the
  // "_R1234" convention this collapse regex was originally written around —
  // observed: a real posting id shaped like digits, then letters, then more
  // digits, plus a "-1" revision suffix (e.g. "_99ZZ123456-1" below, a
  // synthetic id in the same shape). One entry point (a
  // department listing) links straight to "/job/{slug}" with no location
  // segment at all; another (search/LinkedIn) links to
  // "/job/{location}/{slug}" for the exact same posting. Without
  // generalizing this regex the same way roleFromJobSlug's already was
  // (see its comment above), these normalize to two different keys and an
  // already-Applied job looks untracked from the other entry point.
  assert.equal(
    normalizeUrl('https://acme.wd1.myworkdayjobs.com/en-US/Ext/job/Widget-Builder--Principal-Product-Manager_99ZZ123456-1'),
    normalizeUrl('https://acme.wd1.myworkdayjobs.com/Ext/job/Example-City-XX/Widget-Builder--Principal-Product-Manager_99ZZ123456-1?src=JB-10065&source=LinkedIn'),
  );
});

test('normalizeUrl returns null for a malformed URL instead of throwing', () => {
  assert.equal(normalizeUrl('not a url'), null);
});

test('normalizeUrl keeps a query-param job ID when the path has none, instead of collapsing every posting on the host+path to one key', () => {
  // Regression: some ATS platforms put the actual distinguishing job ID in
  // a query param, not the path (observed: an hrmdirect-hosted career site
  // using "?req=<id>" — every posting on that site shares the exact same
  // path, "/employment/job-opening.php", which has no digits/UUID of its
  // own). The old normalizeUrl only ever read pathname, silently dropping
  // the query string entirely — two completely different tracked postings
  // on the same host+path collapsed to one normalized key, so the popup
  // showed one job's tracked status (stage, notes) on the other job's page.
  assert.notEqual(
    normalizeUrl('https://acme.hrmdirect.com/employment/job-opening.php?req=1111111'),
    normalizeUrl('https://acme.hrmdirect.com/employment/job-opening.php?req=2222222'),
  );
});

test('normalizeUrl drops the whole query string when the path already has a strong id (a long digit run or a UUID)', () => {
  // Ashby-hosted postings already carry the full job UUID in the path
  // itself, so the query is redundant regardless of what it contains —
  // whether or not a tracked entry's URL happened to carry "?src=LinkedIn"
  // (a real one did) shouldn't matter.
  assert.equal(
    normalizeUrl('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?src=LinkedIn'),
    normalizeUrl('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  );
});

test('normalizeUrl treats an Ashby job\'s "/application" sub-page as the same posting as its base job URL', () => {
  // Ashby's own "Apply" button navigates from the base job URL to the same
  // job id with "/application" appended (and drops the "?departmentId=..."
  // query the base URL may have carried, since it's not part of the id).
  // Without stripping this, re-visiting the base job URL after applying
  // normalizes to a different key than the one saved at apply-time, and the
  // popup shows the job as untracked even though it's already Applied.
  assert.equal(
    normalizeUrl('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/application'),
    normalizeUrl('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?departmentId=bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
  );
});

test('normalizeUrl: LinkedIn\'s own per-visit tracking params never affect the normalized key, only its path-based job id does', () => {
  // Critical regression check against the fix above: LinkedIn job URLs
  // already carry the real job id in the path, but ALSO carry huge
  // tracking query strings (trk/refId/trackingId/eBP) that are a different,
  // effectively random value on every single visit to the very same job —
  // even reopening the identical email digest link twice produces two
  // different query strings. If a fix for the hrmdirect-style bug above
  // naively started keeping query strings by default instead of using this
  // path-based check, it would silently break recognizing an already-
  // tracked LinkedIn job as tracked at all (the single largest source of
  // tracked entries in real usage) — exactly as badly as the original bug,
  // just in the opposite direction.
  const a = 'https://www.linkedin.com/jobs/view/4416237219/?trk=eml-abc&refId=xyz1%3D%3D&trackingId=aaa1%3D%3D';
  const b = 'https://www.linkedin.com/jobs/view/4416237219/?trk=eml-def&refId=xyz2%3D%3D&trackingId=bbb2%3D%3D';
  const different = 'https://www.linkedin.com/jobs/view/9999999999/?trk=eml-abc';
  assert.equal(normalizeUrl(a), normalizeUrl(b));
  assert.notEqual(normalizeUrl(a), normalizeUrl(different));
});

test('normalizeUrl: a multi-tenant platform whose path alone is generic still disambiguates via its full (non-tracking) query', () => {
  // A real multi-tenant ATS puts a client/tenant id in one query param and
  // the job id in another, with a path that's identical across every
  // tenant and every job. Since the path has no strong id, the WHOLE query
  // is kept (not just an allowlisted "job id" param name) — otherwise two
  // different companies' numerically-identical job id could collide into
  // the same normalized key. A hand-maintained allowlist of "known job-id
  // param names" would have missed this; keeping the full (non-tracking)
  // query when the path is insufficient handles it without needing to know
  // this platform's param names in advance.
  assert.notEqual(
    normalizeUrl('https://workforcenow.example.com/mdf/recruitment.html?cid=tenant-a&jobId=587589'),
    normalizeUrl('https://workforcenow.example.com/mdf/recruitment.html?cid=tenant-b&jobId=587589'),
  );
});

test('normalizeUrl ignores the hash fragment, and is insensitive to query-param order after stripping tracking noise', () => {
  assert.equal(
    normalizeUrl('https://acme.hrmdirect.com/employment/job-opening.php?req=1111111#job'),
    normalizeUrl('https://acme.hrmdirect.com/employment/job-opening.php?req=1111111'),
  );
  assert.equal(
    normalizeUrl('https://acme.hrmdirect.com/x?req=1&foo=2'),
    normalizeUrl('https://acme.hrmdirect.com/x?foo=2&req=1'),
  );
});

// ---- extractJobInfo / guessCompanyFromTab (full composition) ----
// These compose extractFromKnownAtsUrl + parseJobTitleFallback with a
// precedence rule between them — tested at this level, not just the pieces
// in isolation, because the precedence itself has already had a real bug:
// an earlier version tried the URL-derived company first unconditionally,
// which regressed a real Loxo posting whose *title* had a clean "Role |
// Company" match but whose *URL* only offered a lowercase slug.

test('extractJobInfo: a real Loxo posting keeps the title-derived company over the URL slug', () => {
  assert.deepEqual(
    extractJobInfo('Senior Product Manager | Northwind Co.', 'https://northwind.app.loxo.co/job/OTk5OTktZmFrZWpvYmlkZmFrZWpvYg=='),
    { role: 'Senior Product Manager', company: 'Northwind Co.' },
  );
});

test('extractJobInfo: falls back to the URL-derived company only when the title yields none at all', () => {
  // No JSON-LD, no usable title — this is strictly new coverage the old
  // popup.js never had (it had no Loxo/Workday/Lever/Ashby/Greenhouse URL
  // handling at all), not a regression risk against prior behavior.
  assert.deepEqual(
    extractJobInfo('', 'https://acme.app.loxo.co/job/OTk5OTktZmFrZWpvYmlkZmFrZWpvYg=='),
    { role: '', company: 'Acme' },
  );
});

test('extractJobInfo: Ashby posting via the "@" title fallback keeps full title casing', () => {
  assert.deepEqual(
    extractJobInfo(
      'Staff and Senior Product Manager (Multiple Roles, Multiple Teams) @ Acme Widgets',
      'https://jobs.ashbyhq.com/acme/cccccccc-dddd-eeee-ffff-000000000000',
    ),
    { role: 'Staff and Senior Product Manager (Multiple Roles, Multiple Teams)', company: 'Acme Widgets' },
  );
});

test('extractJobInfo: Workday posting resolves both role and company from the URL alone', () => {
  // Regression: an earlier version of extractFromKnownAtsUrl's Workday
  // branch returned role:null unconditionally, silently losing the
  // URL-derived role popup.js used to get from the old generic-/job/-regex
  // fallback (with the wrong company) before this branch existed — this
  // locks in the fixed, composed behavior: correct company AND role, both
  // from the URL, independent of whatever the raw tab title says.
  assert.deepEqual(
    extractJobInfo(
      'breadcrumb noise unrelated to the role',
      'https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Product-Manager_R123',
    ),
    { role: 'Product Manager', company: 'Acme' },
  );
});

test('extractJobInfo: Rippling (URL-only company, title-only role) trusted outright', () => {
  assert.deepEqual(
    extractJobInfo('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
    { role: 'Product Owner', company: 'Acme' },
  );
});

test('extractJobInfo: Kula.ai\'s cross-checked match is trusted outright', () => {
  assert.deepEqual(
    extractJobInfo('Staff Engineer - Platform - Acme', 'https://careers.kula.ai/acme/123'),
    { role: 'Staff Engineer - Platform', company: 'Acme' },
  );
});

test('extractJobInfo: Wellfound (no known-ATS URL match) still gets the bullet-stripped title company', () => {
  assert.deepEqual(
    extractJobInfo(
      'Senior Product Manager at Acme • Boston • Toronto • Remote (Work from Home) | Wellfound',
      'https://wellfound.com/jobs/4544919-senior-product-manager',
    ),
    { role: 'Senior Product Manager', company: 'Acme' },
  );
});

test('guessCompanyFromTab: always prefers the URL-derived company when a known ATS host matches', () => {
  // Unlike extractJobInfo, there's no role to weigh a title-derived company
  // against here, so the known-ATS-URL company wins unconditionally.
  assert.equal(guessCompanyFromTab('irrelevant title', 'https://northwind.app.loxo.co/job/OTk5OTktZmFrZWpvYmlkZmFrZWpvYg=='), 'Northwind');
  assert.equal(guessCompanyFromTab('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/uuid'), 'Acme');
});

test('guessCompanyFromTab: falls back to title parsing when no known ATS host matches', () => {
  assert.equal(guessCompanyFromTab('Product Manager at Acme Corp', 'https://www.linkedin.com/jobs/view/12345'), 'Acme Corp');
});

test('guessCompanyFromTab: returns null when neither the URL nor the title yields a company', () => {
  assert.equal(guessCompanyFromTab('Python Tutorial - Learn Fast', 'https://www.youtube.com/watch?v=xyz'), null);
});

// ---- stripLeadingOrgCode ----

test('stripLeadingOrgCode: strips a leading numeric reference code and the space after it', () => {
  assert.equal(stripLeadingOrgCode('4521 Acme Manufacturing A/S'), 'Acme Manufacturing A/S');
});

test('stripLeadingOrgCode: leaves a name with no leading number untouched', () => {
  assert.equal(stripLeadingOrgCode('Acme Manufacturing A/S'), 'Acme Manufacturing A/S');
});

test('stripLeadingOrgCode: only strips a code at the very start, not a number appearing later', () => {
  assert.equal(stripLeadingOrgCode('Acme 4521 Manufacturing'), 'Acme 4521 Manufacturing');
});

test('stripLeadingOrgCode: leaves a short (1-2 digit) leading number alone — real companies are named this way', () => {
  // A real ATS-observed reference code was 4 digits; real short numeric
  // company names are 1-2 digits. Requiring 3+ digits catches the former
  // without corrupting the latter.
  assert.equal(stripLeadingOrgCode('12 Rivers Trading'), '12 Rivers Trading');
  assert.equal(stripLeadingOrgCode('3 Oaks Logistics'), '3 Oaks Logistics');
});
