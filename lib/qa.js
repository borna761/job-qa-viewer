// Q&A domain: parsing the plain-text answer files, serializing back, stable
// ids, and display-name helpers. These are pure (except readTxtFile) and are
// the core of the unit tests.
const fs = require('fs');
const crypto = require('crypto');

// Fix 1: require ? at end of line, not anywhere in it —
// prevents answer text like "Is this right? Yes." being misclassified as a question
function isQuestionLine(line) {
  return /\?\s*$/.test(line) || line.trimEnd().endsWith('*');
}

function parseQA(text) {
  const blocks = text.split(/\n{4,}/).map(b => b.trim()).filter(Boolean);
  const pairs = [];
  for (const block of blocks) {
    const newlineIdx = block.indexOf('\n');
    const firstLine = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim();
    const rest = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1).trim();
    if (isQuestionLine(firstLine)) {
      pairs.push({ question: firstLine.replace(/\*\s*$/, '').trim(), answer: rest.replace(/^\n+/, '').trim() });
    } else {
      pairs.push({ question: null, answer: block });
    }
  }
  return pairs;
}

// Fix 2: collapse any 4+ consecutive newlines inside content down to 3
// so they can never be mistaken for block separators on re-parse
function sanitizeContent(text) {
  return (text || '').replace(/\n{4,}/g, '\n\n\n');
}

function serializeQA(pairs) {
  return pairs.map(p => {
    const q = sanitizeContent(p.question);
    const a = sanitizeContent(p.answer);
    if (!q) return a;
    // Ensure the question line survives a round-trip through parseQA.
    // If it doesn't end with ? or * the parser won't recognise it as a
    // question on re-read, so append the silent * marker.
    const qLine = isQuestionLine(q) ? q : q + '*';
    return qLine + '\n' + a;
  }).join('\n\n\n\n');
}

function readTxtFile(filePath) {
  return fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).replace(/\r\n/g, '\n');
}

// Stable ID based on full content
function pairId(p) {
  return crypto.createHash('md5').update((p.question || '') + '||' + p.answer).digest('hex').slice(0, 12);
}

function autoCategory(p, config) {
  const q = (p.question || '').toLowerCase();
  const a = p.answer.toLowerCase();
  for (const rule of config.rules) {
    if (rule.keywords.some(kw => q.includes(kw.toLowerCase()))) return rule.cat;
    if (rule.keywords.some(kw => a.includes(kw.toLowerCase()))) return rule.cat;
  }
  return 'Other';
}

function fileLabel(filename) {
  return filename.replace('.txt', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Canonical display name for a data file, respecting saved overrides.
function displayName(file, companyNames) {
  return companyNames[file] || (file === 'answers.txt' ? 'My Answers' : fileLabel(file));
}

// Convert a human name to a safe slug used as the txt filename stem.
function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = {
  isQuestionLine, parseQA, sanitizeContent, serializeQA,
  readTxtFile, pairId, autoCategory, fileLabel, displayName, nameToSlug,
};
