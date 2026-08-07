// Tests for extension/shared.js — the pure, chrome/DOM-free parsing logic
// shared between background.js's toolbar-badge guess and popup.js's
// save-form fallback. Each case here is a regression lock for a real bug
// found and fixed via live testing against an actual reported posting;
// see the commit history for the original report each one traces back to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  capitalizeWords, titleCase, companyNamesLooselyMatch,
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

// ---- extractFromKnownAtsUrl ----

test('extractFromKnownAtsUrl: Lever/Ashby/Greenhouse use the company-as-first-path-segment shape', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://jobs.lever.co/acme/f8250782-ea79-41ed-93b5-b2f93668218c'),
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

test('extractFromKnownAtsUrl: Workday host match is anchored, not a bare suffix check', () => {
  // A naive .endsWith('myworkdayjobs.com') would also match this lookalike.
  // Path deliberately has no /job/ segment, so this isolates the Workday
  // check itself rather than also exercising the separate generic-/job/
  // fallback (which would legitimately match this same host on its own).
  assert.equal(extractFromKnownAtsUrl(null, 'https://evilmyworkdayjobs.com/careers/openings'), null);
});

test('extractFromKnownAtsUrl: Loxo tenants (acme.app.loxo.co)', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl(null, 'https://acme.app.loxo.co/job/NDI0NzQtNjE4Y2FyaHRqYWZueXJ1dQ=='),
    { role: null, company: 'Acme' },
  );
});

test('extractFromKnownAtsUrl: Rippling strips an optional locale prefix before the company segment', () => {
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/58c02aff-0a95-4d82-b3c5-2f562be5cd22'),
    { role: 'Product Owner', company: 'Acme' },
  );
  assert.deepEqual(
    extractFromKnownAtsUrl('Product Owner', 'https://ats.rippling.com/acme/jobs/58c02aff-0a95-4d82-b3c5-2f562be5cd22'),
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
    extractFromKnownAtsUrl(null, 'https://careers.example.com/job/NDI0NzQtNjE4Y2FyaHRqYWZueXJ1dQ=='),
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

test('normalizeUrl returns null for a malformed URL instead of throwing', () => {
  assert.equal(normalizeUrl('not a url'), null);
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
    extractJobInfo('Senior Product Manager | Northwind Co.', 'https://northwind.app.loxo.co/job/NDI0NzQtNjE4Y2FyaHRqYWZueXJ1dQ=='),
    { role: 'Senior Product Manager', company: 'Northwind Co.' },
  );
});

test('extractJobInfo: falls back to the URL-derived company only when the title yields none at all', () => {
  // No JSON-LD, no usable title — this is strictly new coverage the old
  // popup.js never had (it had no Loxo/Workday/Lever/Ashby/Greenhouse URL
  // handling at all), not a regression risk against prior behavior.
  assert.deepEqual(
    extractJobInfo('', 'https://acme.app.loxo.co/job/NDI0NzQtNjE4Y2FyaHRqYWZueXJ1dQ=='),
    { role: '', company: 'Acme' },
  );
});

test('extractJobInfo: Ashby posting via the "@" title fallback keeps full title casing', () => {
  assert.deepEqual(
    extractJobInfo(
      'Staff and Senior Product Manager (Multiple Roles, Multiple Teams) @ Acme Widgets',
      'https://jobs.ashbyhq.com/acme/40d9a988-8944-4606-9ea1-51262e495768',
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
    extractJobInfo('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/58c02aff-0a95-4d82-b3c5-2f562be5cd22'),
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
  assert.equal(guessCompanyFromTab('irrelevant title', 'https://northwind.app.loxo.co/job/NDI0NzQtNjE4Y2FyaHRqYWZueXJ1dQ=='), 'Northwind');
  assert.equal(guessCompanyFromTab('Product Owner', 'https://ats.rippling.com/en-CA/acme/jobs/uuid'), 'Acme');
});

test('guessCompanyFromTab: falls back to title parsing when no known ATS host matches', () => {
  assert.equal(guessCompanyFromTab('Product Manager at Acme Corp', 'https://www.linkedin.com/jobs/view/12345'), 'Acme Corp');
});

test('guessCompanyFromTab: returns null when neither the URL nor the title yields a company', () => {
  assert.equal(guessCompanyFromTab('Python Tutorial - Learn Fast', 'https://www.youtube.com/watch?v=xyz'), null);
});
