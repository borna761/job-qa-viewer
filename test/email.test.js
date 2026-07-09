const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCompanyFromSubject, isLikelyRole, extractCompany, classifyThread,
  cleanCompanyTerm, roleSearchTerm, roleBodyKeywords, buildJobEmailQuery,
  emailMatchesRole, buildPrimaryByCompany, mergeGmailIntoNotion,
  sanitizeEmailHtml, localDateStr,
} = require('../lib/email');

test('extractCompanyFromSubject pulls the company out of common phrasings', () => {
  assert.equal(extractCompanyFromSubject('Thank you for applying to Acme Corp'), 'Acme Corp');
  assert.equal(extractCompanyFromSubject('Your application to Nova Labs has been received'), 'Nova Labs');
  assert.equal(extractCompanyFromSubject('Lunch tomorrow'), null);
});

test('isLikelyRole distinguishes job titles from company names', () => {
  assert.equal(isLikelyRole('Senior Product Manager'), true);
  assert.equal(isLikelyRole('Acme Corp'), false);
});

test('extractCompany prefers subject, falls back to a non-generic sender domain', () => {
  assert.equal(extractCompany('careers@meridianhealth.com', 'Thanks for applying to Meridian Health'), 'Meridian Health');
  assert.equal(extractCompany('recruiting@stellarinc.com', 'A note about your candidacy'), 'Stellarinc');
  // generic/ATS sender with no usable subject → null
  assert.equal(extractCompany('noreply@greenhouse.io', 'Re: hello'), null);
});

test('classifyThread maps language to a stage', () => {
  assert.equal(classifyThread('Update', 'Unfortunately we will not be moving forward'), 'Rejected');
  assert.equal(classifyThread('Interview', 'Your technical screen is scheduled for Tuesday'), 'Interviews');
  assert.equal(classifyThread('Thanks', 'We received your application'), 'Applied');
});

test('cleanCompanyTerm strips suffixes and punctuation', () => {
  assert.equal(cleanCompanyTerm('Acme Inc'), 'Acme');
  assert.equal(cleanCompanyTerm('Nova Labs Careers'), 'Nova Labs');
});

test('roleSearchTerm keeps distinctive words, drops generic ones', () => {
  // "platform" is in ROLE_STRIP (too generic), so only "Data" survives
  assert.equal(roleSearchTerm('Senior Product Manager, Data Platform'), 'Data');
  assert.equal(roleSearchTerm('Product Manager, Tandem'), 'Tandem');
  assert.equal(roleSearchTerm('Product Manager'), null);
  assert.equal(roleSearchTerm(null), null);
});

test('roleBodyKeywords strips level and generic words, lowercases', () => {
  // "senior", "pm", and "platform" are all in BODY_ROLE_STRIP
  assert.deepEqual(roleBodyKeywords('Senior PM - Data Platform'), ['data']);
  assert.deepEqual(roleBodyKeywords('Product Manager, Tandem'), ['tandem']);
  assert.deepEqual(roleBodyKeywords('Sr. Product Manager, Fusion'), ['fusion']);
});

test('buildJobEmailQuery uses subject+from clause; always includes job keywords', () => {
  const withRole = buildJobEmailQuery('Acme', 'Tandem');
  assert.match(withRole, /subject:"Acme"/);
  assert.match(withRole, /from:acme/);
  assert.match(withRole, /"Tandem"/);
  // JOB_KEYWORDS always present as OR fallback so ATS confirmation emails are caught
  assert.match(withRole, /"your application"/);
  assert.match(withRole, /newer_than:730d/);

  const companyOnly = buildJobEmailQuery('Acme', null);
  assert.match(companyOnly, /subject:"Acme"/);
  assert.match(companyOnly, /from:acme/);
  assert.match(companyOnly, /"your application"/);
});

test('emailMatchesRole: all-or-nothing keyword match', () => {
  assert.equal(emailMatchesRole('about the data platform team', ['data', 'platform']), true);
  assert.equal(emailMatchesRole('only data here', ['data', 'platform']), false);
  assert.equal(emailMatchesRole('unrelated text', ['data']), true);   // zero hits pass
  assert.equal(emailMatchesRole('anything', []), true);               // no keywords pass
});

test('buildPrimaryByCompany picks the most active entry per company', () => {
  const primary = buildPrimaryByCompany([
    { company: 'Acme', stage: 'Applied' },
    { company: 'Acme', stage: 'Interviews' },
    { company: 'Nova', stage: 'Rejected' },
  ]);
  assert.equal(primary.get('acme').stage, 'Interviews');
  assert.equal(primary.get('nova').stage, 'Rejected');
});

test('mergeGmailIntoNotion advances the primary stage/date from Gmail', () => {
  const merged = mergeGmailIntoNotion(
    [{ company: 'Acme', role: null, stage: 'Applied', lastUpdate: null }],
    [{ company: 'Acme', stage: 'Rejected', lastUpdate: '2026-02-01T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Rejected');
  assert.equal(merged[0].lastUpdate, '2026-02-01T00:00:00.000Z');
});

test('sanitizeEmailHtml strips scripts, inline handlers, and javascript: URLs', () => {
  assert.equal(sanitizeEmailHtml('<script>alert(1)</script>hello'), 'hello');
  assert.doesNotMatch(sanitizeEmailHtml('<p onclick="steal()">hi</p>'), /onclick/);
  assert.match(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>'), /href="#"/);
});

test('localDateStr returns a YYYY-MM-DD string', () => {
  assert.match(localDateStr(Date.UTC(2026, 0, 15, 12)), /^\d{4}-\d{2}-\d{2}$/);
});
