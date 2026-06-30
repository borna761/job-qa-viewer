const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isQuestionLine, parseQA, serializeQA, sanitizeContent,
  pairId, autoCategory, fileLabel, displayName, nameToSlug,
} = require('../lib/qa');
const { DEFAULT_CONFIG } = require('../lib/store');

test('isQuestionLine: trailing ? or * marks a question', () => {
  assert.equal(isQuestionLine('Why this role?'), true);
  assert.equal(isQuestionLine('Tell me about yourself*'), true);
  assert.equal(isQuestionLine('A statement.'), false);
  // ? mid-line (not trailing) is NOT a question — guards "Is it? Yes." answers
  assert.equal(isQuestionLine('Is it? Yes it is.'), false);
});

test('parseQA: splits pairs on 4+ blank lines, keeps question mark', () => {
  const text = 'What is your strength?\n\nI define problems.\n\n\n\nWho are you?\n\nA PM.';
  const pairs = parseQA(text);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].question, 'What is your strength?');
  assert.equal(pairs[0].answer, 'I define problems.');
  assert.equal(pairs[1].question, 'Who are you?');
});

test('parseQA: a block with no question line yields question=null', () => {
  const pairs = parseQA('Just a freeform note with no question marker here.');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, null);
});

test('serializeQA → parseQA round-trips stably', () => {
  const original = [
    { question: 'What is your strength?', answer: 'I define problems first.' },
    { question: 'A statement question', answer: 'Some answer body.' },
  ];
  const reparsed = parseQA(serializeQA(original));
  assert.equal(reparsed.length, 2);
  assert.equal(reparsed[0].question, 'What is your strength?');
  assert.equal(reparsed[0].answer, 'I define problems first.');
  // questions without ? get a silent * marker, which parseQA strips back off
  assert.equal(reparsed[1].question, 'A statement question');
});

test('sanitizeContent collapses 4+ newlines to 3 so they cannot split pairs', () => {
  assert.equal(sanitizeContent('a\n\n\n\n\n\nb'), 'a\n\n\nb');
});

test('pairId: stable, 12 hex chars, content-sensitive', () => {
  const id = pairId({ question: 'Q', answer: 'A' });
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, pairId({ question: 'Q', answer: 'A' }));
  assert.notEqual(id, pairId({ question: 'Q', answer: 'B' }));
});

test('fileLabel / displayName', () => {
  assert.equal(fileLabel('fabrikam-software.txt'), 'Fabrikam Software');
  assert.equal(displayName('answers.txt', {}), 'My Answers');
  assert.equal(displayName('northwind.txt', {}), 'Northwind');
  assert.equal(displayName('northwind.txt', { 'northwind.txt': 'Northwind Inc' }), 'Northwind Inc');
});

test('nameToSlug: lowercases and replaces non-alphanumerics, trims dashes', () => {
  assert.equal(nameToSlug('FabriKam Software'), 'fabrikam-software');
  assert.equal(nameToSlug("Don't apply"), 'don-t-apply');
  assert.equal(nameToSlug('  Hi!  '), 'hi');
});

test('autoCategory matches default rules, falls back to Other', () => {
  assert.equal(autoCategory({ question: 'How do you use AI tools?', answer: 'x' }, DEFAULT_CONFIG), 'AI & Tools');
  assert.equal(autoCategory({ question: 'Walk me through your roadmap', answer: 'x' }, DEFAULT_CONFIG), 'Product Process');
  assert.equal(autoCategory({ question: 'Totally unrelated', answer: 'nothing here' }, DEFAULT_CONFIG), 'Other');
});
