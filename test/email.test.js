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
  assert.equal(roleSearchTerm('Product Manager, Zephyr'), 'Zephyr');
  assert.equal(roleSearchTerm('Product Manager'), null);
  assert.equal(roleSearchTerm(null), null);
});

test('roleBodyKeywords strips level and generic words, lowercases', () => {
  // "senior", "pm", and "platform" are all in BODY_ROLE_STRIP
  assert.deepEqual(roleBodyKeywords('Senior PM - Data Platform'), ['data']);
  assert.deepEqual(roleBodyKeywords('Product Manager, Zephyr'), ['zephyr']);
  assert.deepEqual(roleBodyKeywords('Sr. Product Manager, Nimbus'), ['nimbus']);
});

test('buildJobEmailQuery uses subject+from clause; always includes job keywords', () => {
  const withRole = buildJobEmailQuery('Acme', 'Zephyr');
  assert.match(withRole, /subject:"Acme"/);
  assert.match(withRole, /from:acme/);
  assert.match(withRole, /"Zephyr"/);
  // JOB_KEYWORDS always present as OR fallback so ATS confirmation emails are caught
  assert.match(withRole, /"your application"/);
  assert.match(withRole, /newer_than:730d/);

  const companyOnly = buildJobEmailQuery('Acme', null);
  assert.match(companyOnly, /subject:"Acme"/);
  assert.match(companyOnly, /from:acme/);
  assert.match(companyOnly, /"your application"/);

  // strict=true omits JOB_KEYWORDS so only role-term matches are returned
  const strict = buildJobEmailQuery('Acme', 'Zephyr', { strict: true });
  assert.match(strict, /"Zephyr"/);
  assert.doesNotMatch(strict, /"your application"/);

  // dots in company name are preserved in fromTerm so "from:booking.com" works
  const dotDomain = buildJobEmailQuery('Booking.com', 'Engineer');
  assert.match(dotDomain, /from:booking\.com/);
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

test('mergeGmailIntoNotion never downgrades Interviews back to Applied', () => {
  // Regression: classifyThread only recognizes narrow interview-scheduling
  // phrasing ("...scheduled/invitation/confirmed/link"); a thread like
  // "Thank you for your interview with X" or a reschedule/cancellation
  // notice falls through to the Applied default despite clearly being
  // further along than a first application. That default classification
  // must never overwrite a genuinely-set Interviews stage.
  const merged = mergeGmailIntoNotion(
    [{ company: 'Northwind', role: null, stage: 'Interviews', lastUpdate: '2026-01-01T00:00:00.000Z' }],
    [{ company: 'Northwind', stage: 'Applied', lastUpdate: '2026-02-01T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Interviews');
  // The date can still advance even when the stage doesn't — a later Applied-
  // classified email is still real evidence of recent activity on the thread.
  assert.equal(merged[0].lastUpdate, '2026-02-01T00:00:00.000Z');
});

test('mergeGmailIntoNotion still advances Interviews to Rejected (catches a missed rejection)', () => {
  const merged = mergeGmailIntoNotion(
    [{ company: 'Contoso', role: null, stage: 'Interviews', lastUpdate: null }],
    [{ company: 'Contoso', stage: 'Rejected', lastUpdate: '2026-03-01T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Rejected');
});

test('mergeGmailIntoNotion advances Interested to Applied', () => {
  const merged = mergeGmailIntoNotion(
    [{ company: 'Acme', role: null, stage: 'Interested', lastUpdate: null }],
    [{ company: 'Acme', stage: 'Applied', lastUpdate: '2026-01-15T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Applied');
});

test('mergeGmailIntoNotion revives a Stale entry when Gmail confidently detects an interview', () => {
  // 'Stale' is a manual Notion bucket, not something classifyThread ever
  // outputs — a real "your interview is scheduled" match is strong enough
  // evidence that the manual bucketing is out of date and should be revived.
  const merged = mergeGmailIntoNotion(
    [{ company: 'Fabrikam', role: null, stage: 'Stale', lastUpdate: null }],
    [{ company: 'Fabrikam', stage: 'Interviews', lastUpdate: '2026-04-01T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Interviews');
});

test('mergeGmailIntoNotion revives a Turned Down entry when Gmail confidently detects a rejection', () => {
  const merged = mergeGmailIntoNotion(
    [{ company: 'Globex', role: null, stage: 'Turned Down', lastUpdate: null }],
    [{ company: 'Globex', stage: 'Rejected', lastUpdate: '2026-04-01T00:00:00.000Z' }],
  );
  assert.equal(merged[0].stage, 'Rejected');
});

test('mergeGmailIntoNotion does not let a weak Applied default overwrite Stale or Turned Down', () => {
  const merged = mergeGmailIntoNotion(
    [
      { company: 'Fabrikam', role: null, stage: 'Stale', lastUpdate: null },
      { company: 'Globex', role: null, stage: 'Turned Down', lastUpdate: null },
    ],
    [
      { company: 'Fabrikam', stage: 'Applied', lastUpdate: '2026-04-01T00:00:00.000Z' },
      { company: 'Globex', stage: 'Applied', lastUpdate: '2026-04-01T00:00:00.000Z' },
    ],
  );
  assert.equal(merged[0].stage, 'Stale');
  assert.equal(merged[1].stage, 'Turned Down');
});

test('sanitizeEmailHtml strips scripts, inline handlers, and javascript: URLs', () => {
  assert.equal(sanitizeEmailHtml('<script>alert(1)</script>hello'), 'hello');
  assert.doesNotMatch(sanitizeEmailHtml('<p onclick="steal()">hi</p>'), /onclick/);
  assert.match(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>'), /href="#"/);
});

test('localDateStr returns a YYYY-MM-DD string', () => {
  assert.match(localDateStr(Date.UTC(2026, 0, 15, 12)), /^\d{4}-\d{2}-\d{2}$/);
});
