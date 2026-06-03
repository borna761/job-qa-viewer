const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3456;

const DATA_DIR    = path.join(__dirname, 'data');
const GENERAL_FILE = path.join(DATA_DIR, 'answers.txt');
const ORDER_FILE  = path.join(__dirname, 'order.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ---- Parsing ----

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
    return q ? q + '\n' + a : a;
  }).join('\n\n\n\n');
}

function readTxtFile(filePath) {
  return fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).replace(/\r\n/g, '\n');
}

// Stable ID based on full content
function pairId(p) {
  return crypto.createHash('md5').update((p.question || '') + '||' + p.answer).digest('hex').slice(0, 12);
}

// ---- Config (categories + auto-categorisation rules) ----

const DEFAULT_CONFIG = {
  categories: [
    'Background & Motivation',
    'Product Process',
    'Technical Skills',
    'AI & Tools',
    'Culture & Team Fit',
    'Other',
  ],
  rules: [
    { cat: 'AI & Tools',              keywords: ['ai', 'artificial intelligence', 'gpt', 'claude', 'cursor', 'llm', 'tooling'] },
    { cat: 'Culture & Team Fit',      keywords: ['team fit', 'company culture', 'work environment', 'why join', 'early stage', 'startup', 'remote', 'values', 'fun', 'creative'] },
    { cat: 'Background & Motivation', keywords: ['drawing you', 'why pm', 'why product', 'why role', 'customer-facing', 'started my career'] },
    { cat: 'Product Process',         keywords: ['spec', 'launch', 'feature', 'decision', 'user interview', 'mvp', 'roadmap', 'priorities'] },
    { cat: 'Technical Skills',        keywords: ['technical', 'api', 'dev lead', 'dev team', 'engineer', 'non-technical'] },
  ],
};

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_CONFIG, ...saved };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
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

// ---- Order config ----

// Fix 3: use a null-prototype object so arbitrary id keys (e.g. '__proto__')
// can never pollute Object.prototype
function loadOrder() {
  try {
    return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')));
  } catch {
    return Object.create(null);
  }
}

function saveOrder(order) {
  fs.writeFileSync(ORDER_FILE, JSON.stringify(order, null, 2), 'utf8');
}

// ---- Data ----

function fileLabel(filename) {
  return filename.replace('.txt', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getAll() {
  const config = loadConfig();
  const raw = [];

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.txt'))
    .sort((a, b) => a === 'answers.txt' ? -1 : b === 'answers.txt' ? 1 : a.localeCompare(b));

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const source = file === 'answers.txt' ? 'My Answers' : fileLabel(file);
    const text = readTxtFile(filePath);
    parseQA(text).forEach((p, idx) => {
      if (p.question || p.answer.length > 50)
        raw.push({ ...p, source, filePath, pairIndex: idx });
    });
  }

  const order = loadOrder();

  // Attach id + category (from saved order or auto-detect)
  const pairs = raw.map(p => {
    const id = pairId(p);
    const saved = order[id];
    return {
      ...p,
      id,
      category: saved?.category ?? autoCategory(p, config),
      sortIndex: saved?.sortIndex ?? 999,
    };
  });

  // Sort: by category order, then sortIndex, then original position
  const catOrder = Object.fromEntries(config.categories.map((c, i) => [c, i]));
  pairs.sort((a, b) => {
    const cd = (catOrder[a.category] ?? 99) - (catOrder[b.category] ?? 99);
    if (cd !== 0) return cd;
    return a.sortIndex - b.sortIndex;
  });

  return { pairs, categories: config.categories };
}

// ---- Routes ----

app.use(express.json());

app.get('/api/data', (req, res) => {
  try { res.json(getAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/order', (req, res) => {
  try {
    const order = loadOrder();
    for (const item of req.body) {
      // Fix 3 (cont): validate id is a plain non-empty string before writing
      if (!item.id || typeof item.id !== 'string') continue;
      order[item.id] = {
        category:  String(item.category  ?? ''),
        sortIndex: Number(item.sortIndex ?? 0),
      };
    }
    saveOrder(order);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-general', (req, res) => {
  const { question, answer, source, category } = req.body;
  if (!answer) return res.status(400).json({ error: 'Answer is required' });

  // Resolve target file — strip any path components to prevent traversal
  let targetFile = GENERAL_FILE;
  if (source && source !== 'answers.txt') {
    const safe = path.basename(source);
    if (!safe.endsWith('.txt')) return res.status(400).json({ error: 'Invalid source' });
    const resolved = path.join(DATA_DIR, safe);
    if (!resolved.startsWith(DATA_DIR + path.sep)) return res.status(400).json({ error: 'Invalid source' });
    targetFile = resolved;
  }

  try {
    const text = fs.existsSync(targetFile) ? readTxtFile(targetFile) : '';
    const pairs = text ? parseQA(text).filter(p => p.question || p.answer.length > 50) : [];
    const newPair = { question: question || null, answer };
    pairs.push(newPair);
    fs.writeFileSync(targetFile, serializeQA(pairs), 'utf8');

    const newId = pairId(newPair);

    // Persist explicit category so the card lands in the right section immediately
    if (category && typeof category === 'string') {
      const order = loadOrder();
      order[newId] = { category, sortIndex: 9999 };
      saveOrder(order);
    }

    res.json({ ok: true, newId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/companies', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.txt'))
      .sort((a, b) => a === 'answers.txt' ? -1 : b === 'answers.txt' ? 1 : a.localeCompare(b));
    res.json(files.map(f => ({ file: f, name: f === 'answers.txt' ? 'My Answers' : fileLabel(f) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-company', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required' });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return res.status(400).json({ error: 'Invalid name' });
  const filePath = path.join(DATA_DIR, slug + '.txt');
  if (fs.existsSync(filePath)) return res.status(400).json({ error: 'Company already exists' });
  try {
    fs.writeFileSync(filePath, '', 'utf8');
    res.json({ ok: true, file: slug + '.txt', name: fileLabel(slug + '.txt') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rename-company', (req, res) => {
  const { oldFile, newName } = req.body;
  if (!oldFile || !newName || typeof oldFile !== 'string' || typeof newName !== 'string')
    return res.status(400).json({ error: 'oldFile and newName are required' });
  const safeOld = path.basename(oldFile);
  if (!safeOld.endsWith('.txt')) return res.status(400).json({ error: 'Invalid file' });
  const oldPath = path.join(DATA_DIR, safeOld);
  if (!oldPath.startsWith(DATA_DIR + path.sep)) return res.status(400).json({ error: 'Invalid file' });
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Company not found' });
  const slug = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return res.status(400).json({ error: 'Invalid name' });
  const newFile = slug + '.txt';
  const newPath = path.join(DATA_DIR, newFile);
  if (fs.existsSync(newPath)) return res.status(400).json({ error: 'A company with that name already exists' });
  try {
    fs.renameSync(oldPath, newPath);
    res.json({ ok: true, file: newFile, name: fileLabel(newFile) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update', (req, res) => {
  const { filePath, id, question, answer } = req.body;
  // Fix 4: resolve the path before checking so '../' sequences can't escape DATA_DIR
  const resolvedPath = path.resolve(filePath || '');
  if (!resolvedPath.startsWith(DATA_DIR + path.sep))
    return res.status(400).json({ error: 'Invalid file path' });
  try {
    const text = fs.readFileSync(resolvedPath, { encoding: 'utf8' }).replace(/\r\n/g, '\n');
    const pairs = parseQA(text).filter(p => p.question || p.answer.length > 50);
    const idx = pairs.findIndex(p => pairId(p) === id);
    if (idx === -1)
      return res.status(400).json({ error: 'Pair not found' });
    pairs[idx] = { question, answer };
    fs.writeFileSync(resolvedPath, serializeQA(pairs), 'utf8');
    res.json({ ok: true, newId: pairId(pairs[idx]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', (req, res) => {
  try { res.json(loadConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', (req, res) => {
  try {
    const { categories, rules } = req.body;
    if (!Array.isArray(categories) || !Array.isArray(rules))
      return res.status(400).json({ error: 'Invalid config' });
    // Validate individual items so a corrupt rule can't crash autoCategory later
    if (!categories.every(c => typeof c === 'string' && c.length > 0))
      return res.status(400).json({ error: 'categories must be non-empty strings' });
    if (!rules.every(r => typeof r.cat === 'string' && Array.isArray(r.keywords) &&
                          r.keywords.every(k => typeof k === 'string')))
      return res.status(400).json({ error: 'each rule must have a string cat and string[] keywords' });
    saveConfig({ categories, rules });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Job Q&A Viewer running at http://localhost:${PORT}`));
