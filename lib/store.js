// Persistence for config/order JSON files and the getAll() aggregation that
// powers the Q&A tab.
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ORDER_FILE, CONFIG_FILE } = require('./config');
const { readTxtFile, parseQA, pairId, autoCategory, displayName } = require('./qa');

const DEFAULT_CONFIG = {
  categories: [
    'Background & Motivation',
    'Product Process',
    'Technical Skills',
    'AI & Tools',
    'Culture & Team Fit',
    'Other',
  ],
  companyNames: {},  // file → display name override; falls back to fileLabel
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
    // Deep-merge companyNames so DEFAULT_CONFIG is never mutated
    return { ...DEFAULT_CONFIG, ...saved, companyNames: { ...DEFAULT_CONFIG.companyNames, ...(saved.companyNames || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG, companyNames: { ...DEFAULT_CONFIG.companyNames } };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

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

function getAll() {
  const config = loadConfig();
  const raw = [];

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.txt'))
    .sort((a, b) => a === 'answers.txt' ? -1 : b === 'answers.txt' ? 1 : a.localeCompare(b));

  const companyNames = config.companyNames;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const source = displayName(file, companyNames);
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

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, loadOrder, saveOrder, getAll };
