const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env file if present (KEY=value, ignores comments and blank lines)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
} catch { /* .env is optional */ }

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

// Canonical display name for a data file, respecting saved overrides.
function displayName(file, companyNames) {
  return companyNames[file] || (file === 'answers.txt' ? 'My Answers' : fileLabel(file));
}

// Convert a human name to a safe slug used as the txt filename stem.
function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    const cfg   = loadConfig();
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.txt'))
      .sort((a, b) => a === 'answers.txt' ? -1 : b === 'answers.txt' ? 1 : a.localeCompare(b));
    res.json(files.map(f => ({ file: f, name: displayName(f, cfg.companyNames) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-company', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required' });
  const trimmed = name.trim();
  const slug = nameToSlug(trimmed);
  if (!slug) return res.status(400).json({ error: 'Invalid name' });
  const file = slug + '.txt';
  const filePath = path.join(DATA_DIR, file);
  if (fs.existsSync(filePath)) return res.status(400).json({ error: 'Company already exists' });
  try {
    fs.writeFileSync(filePath, '', 'utf8');
    const cfg = loadConfig();
    cfg.companyNames[file] = trimmed;
    saveConfig(cfg);
    res.json({ ok: true, file, name: trimmed });
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
  const trimmed = newName.trim();
  const slug = nameToSlug(trimmed);
  if (!slug) return res.status(400).json({ error: 'Invalid name' });
  const newFile = slug + '.txt';
  const newPath = path.join(DATA_DIR, newFile);
  try {
    // Only rename the file if the slug actually changed
    if (newFile !== safeOld) {
      if (fs.existsSync(newPath)) return res.status(400).json({ error: 'A company with that name already exists' });
      fs.renameSync(oldPath, newPath);
    }
    // Always store the exact display name chosen by the user
    const cfg = loadConfig();
    delete cfg.companyNames[safeOld];
    cfg.companyNames[newFile] = trimmed;
    saveConfig(cfg);
    res.json({ ok: true, file: newFile, name: trimmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/move-entry', (req, res) => {
  const { fromFile, toFile, id } = req.body;
  if (!fromFile || !toFile || !id) return res.status(400).json({ error: 'fromFile, toFile, and id are required' });
  const fromPath = path.join(DATA_DIR, path.basename(fromFile));
  const toPath   = path.join(DATA_DIR, path.basename(toFile));
  // Guard after normalisation so 'foo.txt' vs './foo.txt' is correctly caught
  if (fromPath === toPath) return res.json({ ok: true });
  if (!fromPath.startsWith(DATA_DIR + path.sep) || !toPath.startsWith(DATA_DIR + path.sep))
    return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(fromPath)) return res.status(404).json({ error: 'Source file not found' });
  if (!fs.existsSync(toPath))   return res.status(404).json({ error: 'Destination file not found' });
  try {
    // Read both files before writing either — no destructive write happens
    // until we know both reads succeeded and the entry exists.
    const fromPairs = parseQA(readTxtFile(fromPath)).filter(p => p.question || p.answer.length > 50);
    const idx = fromPairs.findIndex(p => pairId(p) === id);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
    const toPairs = parseQA(readTxtFile(toPath)).filter(p => p.question || p.answer.length > 50);
    const [moved] = fromPairs.splice(idx, 1);
    toPairs.push(moved);
    fs.writeFileSync(fromPath, serializeQA(fromPairs), 'utf8');
    fs.writeFileSync(toPath,   serializeQA(toPairs),   'utf8');
    res.json({ ok: true });
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
    const existing = loadConfig();
    saveConfig({ categories, rules, companyNames: existing.companyNames });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---- Tracker (Notion + Gmail) ----

const NOTION_PAGE_ID   = process.env.NOTION_PAGE_ID;
const GMAIL_TOKEN_FILE = path.join(__dirname, 'gmail-token.json');
const GMAIL_REDIRECT   = `http://localhost:${PORT}/api/tracker/auth/callback`;
const GMAIL_QUERY_FULL = 'subject:(application OR interview OR offer OR recruiter OR hiring) newer_than:180d';
const GMAIL_QUERY_DAY  = 'subject:(application OR interview OR offer OR recruiter OR hiring) newer_than:1d';

// -- Notion --

async function notionFetch(endpoint, options = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw Object.assign(new Error('NOTION_TOKEN not set'), { code: 'missing_token' });
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllNotionBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const qs  = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const data = await notionFetch(`blocks/${pageId}/children${qs}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

// Maps Notion stage-page titles → tracker stage names
const NOTION_SECTION_MAP = {
  active:      'Applied',
  notapplied:  'Interested',
  interviews:  'Interviews',
  turneddown:  'Turned Down',
  stale:       'Stale',
  inactive:    'Rejected',
  // dontapply: intentionally absent → skipped
};

function parseTitleToApp(block, stage) {
  const title      = block.child_page?.title || '';
  const lastUpdate = block.created_time || null;
  // Title format: "[🔗 link] — Role | Company"
  const body    = title.replace(/^\[.*?\]\s*[—–-]\s*/, '');
  const pipeIdx = body.indexOf(' | ');
  if (pipeIdx !== -1) {
    const role    = body.slice(0, pipeIdx).trim();
    const company = body.slice(pipeIdx + 3).trim();
    return { company, role: role || null, stage, lastUpdate, source: 'notion', notionPageId: block.id };
  }
  const company = body.trim();
  return company ? { company, role: null, stage, lastUpdate, source: 'notion', notionPageId: block.id } : null;
}

async function loadNotionApps() {
  const topBlocks  = await fetchAllNotionBlocks(NOTION_PAGE_ID);
  const stagePages = topBlocks.filter(b => {
    if (b.type !== 'child_page' || b.archived || b.in_trash) return false;
    const key = b.child_page.title.toLowerCase().replace(/[^a-z]/g, '');
    if (!NOTION_SECTION_MAP[key]) {
      console.warn(`[tracker] Unknown Notion section ignored: "${b.child_page.title}" (key: "${key}") — add it to NOTION_SECTION_MAP if it should be tracked`);
      return false;
    }
    return true;
  });

  // Fetch all stage pages in parallel
  const stageResults = await Promise.all(stagePages.map(async sp => {
    const key   = sp.child_page.title.toLowerCase().replace(/[^a-z]/g, '');
    const stage = NOTION_SECTION_MAP[key];
    const children = await fetchAllNotionBlocks(sp.id);
    return { stage, children };
  }));

  const apps = [];
  for (const { stage, children } of stageResults) {
    for (const child of children) {
      if (child.type !== 'child_page' || child.archived || child.in_trash) continue;
      const app = parseTitleToApp(child, stage);
      if (app) apps.push(app);
    }
  }
  return apps;
}

// -- Gmail OAuth --

function loadGmailToken() {
  try { return JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function saveGmailToken(token) {
  fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(token, null, 2), 'utf8');
}

async function getGmailAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw Object.assign(new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set'), { code: 'missing_client' });
  const token = loadGmailToken();
  if (!token?.refresh_token)
    throw Object.assign(new Error('Gmail not authorised — visit /api/tracker/auth'), { code: 'needs_auth' });
  if (!token.access_token || (token.expiry_date && token.expiry_date < Date.now() + 60_000)) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: token.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    });
    const fresh = await res.json();
    if (!res.ok) throw new Error(`Token refresh: ${fresh.error_description || fresh.error}`);
    token.access_token = fresh.access_token;
    token.expiry_date  = Date.now() + (fresh.expires_in || 3600) * 1000;
    saveGmailToken(token);
  }
  return token.access_token;
}

async function gmailApiFetch(path, accessToken) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}

// -- Gmail classification --

const ATS_DOMAINS = new Set([
  'lever', 'greenhouse', 'workday', 'myworkday', 'ashbyhq', 'jobvite', 'breezy',
  'smartrecruiters', 'icims', 'taleo', 'bamboohr', 'recruitee', 'personio',
  'workable', 'workablemail', 'applytojob', 'hire', 'gem', 'jazz', 'pinpoint',
  'dover', 'rippling', 'gusto', 'namely', 'paychex', 'successfactors',
  'adp', 'talent', 'talentreef', 'talentlyft', 'comeet', 'freshteam',
]);
const GENERIC_DOMAINS = new Set([
  'gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'me', 'mac',
  'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'monster', 'careerbuilder',
]);

function extractCompanyFromSubject(subject) {
  const patterns = [
    /application (?:to|at|with|for)\s+([A-Z][a-zA-Z0-9\s&.,'-]{1,45}?)(?:\s*[-–|,!(\n]|$)/i,
    /(?:thank(?:s| you)) for applying (?:to|at|with)\s+([A-Z][a-zA-Z0-9\s&.,'-]{1,45}?)(?:\s*[-–|,!]|$)/i,
    /^([A-Z][a-zA-Z0-9\s&.'-]{1,40}?)\s*[-–:]\s*(?:your )?application/i,
    /(?:role|position) (?:of .+? )?at\s+([A-Z][a-zA-Z0-9\s&.,'-]{1,45}?)(?:\s*[-–|,]|$)/i,
    /\|\s*([A-Z][a-zA-Z0-9\s&.,'-]{1,45}?)\s*(?:jobs?|careers?)?\s*$/i,
  ];
  const JUNK_SUFFIX = /\s+(has been|received|confirmed|submitted|sent|updated|approved|rejected)\b.*/i;
  for (const p of patterns) {
    const m = subject.match(p);
    if (m) {
      const c = m[1].trim().replace(/\s+/g, ' ').replace(JUNK_SUFFIX, '');
      if (c.length > 2 && c.length < 50) return c;
    }
  }
  return null;
}

const ROLE_WORDS = new Set(['senior', 'product', 'manager', 'lead', 'director', 'associate', 'junior', 'technical', 'engineer', 'developer', 'owner', 'analyst', 'specialist', 'consultant', 'coordinator', 'principal', 'staff', 'head', 'vp', 'chief']);

function isLikelyRole(name) {
  if (name.length < 2) return true;
  const words = name.toLowerCase().split(/\s+/);
  return words.length <= 3 && words.every(w => ROLE_WORDS.has(w));
}

function extractCompany(from, subject) {
  // Try subject first — works for both ATS-sent and direct emails
  const fromSubject = extractCompanyFromSubject(subject);
  if (fromSubject && !isLikelyRole(fromSubject)) return fromSubject;
  // Fall back to sender domain for direct company emails
  const domainMatch = from.match(/@([\w-]+)\./);
  if (domainMatch) {
    const d = domainMatch[1].toLowerCase();
    if (!GENERIC_DOMAINS.has(d) && !ATS_DOMAINS.has(d))
      return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return null;
}

function classifyThread(subject, snippet) {
  const t = (subject + ' ' + (snippet || '')).toLowerCase();
  if (/not moving forward|not selected|other candidates|position.*filled|won.t be moving|unfortunately.*not|regret to inform/i.test(t)) return 'Rejected';
  if (/(interview|technical screen|coding (challenge|test)|take.home|on.site|virtual interview).*(scheduled|invitation|confirmed|link)|hiring manager (call|interview)/i.test(t)) return 'Interviews';
  return 'Applied';
}

async function fetchGmailApps(query) {
  const access   = await getGmailAccessToken();
  const listData = await gmailApiFetch(`users/me/threads?q=${encodeURIComponent(query)}&maxResults=50`, access);
  const threads  = listData.threads || [];
  const apps     = [];
  await Promise.all(threads.map(async ({ id }) => {
    try {
      const thread  = await gmailApiFetch(
        `users/me/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, access);
      const lastMsg = (thread.messages || []).at(-1);
      if (!lastMsg) return;
      const hdrs    = Object.fromEntries((lastMsg.payload?.headers || []).map(h => [h.name, h.value]));
      const company = extractCompany(hdrs['From'] || '', hdrs['Subject'] || '');
      if (!company) return;
      apps.push({
        company,
        role:       null,
        stage:      classifyThread(hdrs['Subject'] || '', lastMsg.snippet || ''),
        lastUpdate: lastMsg.internalDate ? new Date(+lastMsg.internalDate).toISOString() : null,
        source:     'gmail',
      });
    } catch { /* skip */ }
  }));
  return apps;
}

// -- Tracker merge (server-side) --
// Notion is the source of truth — Gmail only updates stage/date for existing entries.

// Lower rank = more active/important (used to pick the "primary" entry per company for email enrichment)
const TRACKER_STAGE_RANK = Object.fromEntries(
  ['Interviews', 'Applied', 'Interested', 'Stale', 'Turned Down', 'Rejected'].map((s, i) => [s, i])
);

// Returns a Map<companyKey, app> of the most active (lowest TRACKER_STAGE_RANK) entry per company.
function buildPrimaryByCompany(apps) {
  const map = new Map();
  for (const a of apps) {
    const key = a.company.toLowerCase();
    const existing = map.get(key);
    const rank = TRACKER_STAGE_RANK[a.stage] ?? 99;
    const existingRank = existing ? (TRACKER_STAGE_RANK[existing.stage] ?? 99) : 999;
    if (rank < existingRank) map.set(key, a);
  }
  return map;
}

function mergeGmailIntoNotion(notionApps, gmailApps) {
  // Keep every Notion entry (including duplicates with the same company but different roles)
  const apps = notionApps.map(a => ({ ...a }));
  // Index by company name for Gmail lookup — one company can have multiple entries
  const byCompany = new Map();
  for (const a of apps) {
    const key = a.company.toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(a);
  }
  // When multiple roles exist at the same company, only the primary entry gets Gmail updates.
  const primaryByCompany = buildPrimaryByCompany(apps);
  for (const g of gmailApps) {
    if (!g.company) continue;
    const matches = byCompany.get(g.company.toLowerCase()) || [];
    const primary = primaryByCompany.get(g.company.toLowerCase());
    // Only the primary entry gets stage and date updates from Gmail — secondary entries
    // (other roles at the same company) keep their Notion created_time as-is.
    if (!primary) continue;
    if ((TRACKER_STAGE_RANK[g.stage] ?? -1) > (TRACKER_STAGE_RANK[primary.stage] ?? -1))
      primary.stage = g.stage;
    if (g.lastUpdate && (!primary.lastUpdate || g.lastUpdate > primary.lastUpdate))
      primary.lastUpdate = g.lastUpdate;
  }
  return apps;
}

// Strips generic job title words for Gmail search term extraction.
// ROLE_STRIP includes level words (senior/junior/lead) so both "Senior PM - Data Platform"
// and "PM - Data Platform" reduce to "Data Platform" for a shared search query.
// BODY_ROLE_STRIP keeps level words so the two roles stay distinguishable for body matching.
const ROLE_STRIP      = /\b(senior|junior|lead|principal|staff|associate|sr|jr|product|manager|owner|analyst|pm|po|tpm|tpo|cpo|vp|head|director|remote|canada|canadian|multiple|levels|available|contract|interim|part.?time|full.?time)\b/gi;
const BODY_ROLE_STRIP = /\b(product|manager|owner|analyst|pm|po|tpm|tpo|cpo|vp|head|director|remote|canada|canadian|multiple|levels|available|contract|interim|part.?time|full.?time)\b/gi;

function extractRoleWords(role, stripRe) {
  if (!role) return [];
  return role
    .replace(/\(.*?\)/g, ' ')
    .replace(stripRe, ' ')
    .replace(/[-–—|,\/&+]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2);
}

// Distinctive search term for Gmail queries — strips level words so variants of the same
// role at a company share one query. Returns null when nothing distinctive remains.
function roleSearchTerm(role) {
  const words = extractRoleWords(role, ROLE_STRIP);
  return words.length >= 2 ? words.slice(0, 3).join(' ') : null;
}

// Keywords for post-fetch body filtering — keeps level words (senior/junior/lead) so
// "Senior PM - Data Platform" and "PM - Data Platform" stay distinguishable.
function roleBodyKeywords(role) {
  return extractRoleWords(role, BODY_ROLE_STRIP).map(w => w.toLowerCase());
}

function cleanCompanyTerm(company) {
  return company
    .replace(/"/g, '')
    .replace(/\b(careers?|jobs?|inc\.?|ltd\.?|corp\.?|llc\.?|co\.?|team|hr|recruiting|talent|hiring)\b/gi, '')
    .replace(/[&,;|]+/g, ' ')
    .replace(/\s*\.\s*$/, '')
    .replace(/\s+/g, ' ').trim() || company;
}

// Returns false when the email's text+subject contains SOME but not ALL role keywords,
// indicating it belongs to a different role at the same company.
// Emails with zero keyword matches are generic (calendar invite, etc.) and pass through.
const GMAIL_EXCLUDE = '-from:jobalerts-noreply@linkedin.com -from:hit-noreply@linkedin.com -from:notifications-noreply@linkedin.com -from:indeed.com -from:glassdoor.com -from:ziprecruiter.com -from:monster.com -from:careerbuilder.com -from:jobgether.com';

// Build a Gmail search query for job-related emails at a company/role.
// When a role term is present the query is tightly anchored and needs no keyword clause;
// company-only searches add a keyword clause to cut noise from job digests etc.
function buildJobEmailQuery(companyTerm, roleTerm) {
  // Quote each word individually (not as a phrase) so "Technical Search" from
  // "Technical Product Manager, Search" matches even though the words aren't adjacent.
  const roleClause = roleTerm
    ? ' ' + roleTerm.split(' ').map(w => `"${w}"`).join(' ')
    : '';
  const keywordClause = roleTerm
    ? ''
    : ' (application OR interview OR offer OR recruiter OR hiring OR "thank you for applying" OR "next steps")';
  return `subject:"${companyTerm}"${roleClause}${keywordClause} ${GMAIL_EXCLUDE} newer_than:730d`;
}

function emailMatchesRole(text, keywords) {
  if (!keywords.length) return true;
  const lower = text.toLowerCase();
  const hits = keywords.filter(w => lower.includes(w)).length;
  return hits === 0 || hits === keywords.length;
}

// Fetch the most recent job-related email date for each app (lightweight — metadata only)
async function enrichEmailDates(apps, access) {
  // For entries where we can't extract a distinctive role term, fall back to a company-only
  // search — but only for the most-active entry per company to avoid cross-contamination.
  const primaryIds = new Set(
    [...buildPrimaryByCompany(apps).values()].map(a => a.notionPageId)
  );

  const CONCURRENCY = 20;

  async function fetchDate(app) {
    // For terminal-stage entries, skip only when another active entry at the same company
    // shares the same role search term — that means emails can't be attributed correctly.
    if (app.stage === 'Rejected' || app.stage === 'Turned Down') {
      const thisRoleTerm = roleSearchTerm(app.role);
      if (!thisRoleTerm) return;
      const collision = apps.some(a =>
        a !== app &&
        a.company.toLowerCase() === app.company.toLowerCase() &&
        a.stage !== 'Rejected' && a.stage !== 'Turned Down' &&
        roleSearchTerm(a.role) === thisRoleTerm
      );
      if (collision) return;
    }

    const companyTerm = cleanCompanyTerm(app.company);

    const roleTerm = roleSearchTerm(app.role);

    try {
      // 1. Role-specific search — works for any entry regardless of primary status
      if (roleTerm) {
        const q = buildJobEmailQuery(companyTerm, roleTerm);
        const list = await gmailApiFetch(`users/me/threads?q=${encodeURIComponent(q)}&maxResults=1`, access);
        if (list.threads?.length) {
          const thread = await gmailApiFetch(
            `users/me/threads/${list.threads[0].id}?format=metadata&metadataHeaders=Date`, access);
          const last = (thread.messages || []).at(-1);
          if (last?.internalDate) {
            const date = new Date(+last.internalDate).toISOString();
            if (!app.lastUpdate || date > app.lastUpdate) app.lastUpdate = date;
          }
          return; // found role-specific match — don't fall through to company-only
        }
      }

      // 2. Company-only fallback — restricted to the most-active entry per company
      if (!primaryIds.has(app.notionPageId)) return;
      const q = buildJobEmailQuery(companyTerm, null);
      const list = await gmailApiFetch(`users/me/threads?q=${encodeURIComponent(q)}&maxResults=1`, access);
      if (!list.threads?.length) return;
      const thread = await gmailApiFetch(
        `users/me/threads/${list.threads[0].id}?format=metadata&metadataHeaders=Date`, access);
      const last = (thread.messages || []).at(-1);
      if (!last?.internalDate) return;
      const date = new Date(+last.internalDate).toISOString();
      if (!app.lastUpdate || date > app.lastUpdate) app.lastUpdate = date;
    } catch { /* skip */ }
  }

  for (let i = 0; i < apps.length; i += CONCURRENCY)
    await Promise.allSettled(apps.slice(i, i + CONCURRENCY).map(fetchDate));
}

// -- URL map for Chrome extension --

let urlMapCache = null;
let urlMapCacheTime = 0;
const URL_MAP_TTL = 60 * 1000;

async function buildUrlMap() {
  const apps = await loadNotionApps();
  const CONCURRENCY = 20;
  const entries = [];
  async function fetchOne(app) {
    if (!app.notionPageId) return;
    try {
      const page = await notionFetch(`pages/${app.notionPageId}`);
      const titleSpans = page.properties?.title?.title || [];
      for (const span of titleSpans) {
        const url = span.href || span.text?.link?.url;
        if (url) {
          entries.push({ url, company: app.company, stage: app.stage, role: app.role || null, lastUpdate: app.lastUpdate || null, notionPageId: app.notionPageId });
          break;
        }
      }
    } catch { /* skip */ }
  }
  for (let i = 0; i < apps.length; i += CONCURRENCY)
    await Promise.allSettled(apps.slice(i, i + CONCURRENCY).map(fetchOne));
  return entries;
}

app.get('/api/tracker/urls', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!process.env.NOTION_TOKEN)
    return res.status(503).json({ error: 'notion_not_configured' });
  if (urlMapCache && Date.now() - urlMapCacheTime < URL_MAP_TTL && !req.query.force)
    return res.json(urlMapCache);
  try {
    urlMapCache = await buildUrlMap();
    urlMapCacheTime = Date.now();
    res.json(urlMapCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function htmlToNotionBlocks(html) {
  const MAX = 2000;
  const blocks = [];

  function decode(s) {
    return s
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&[a-z]+;/gi, ' ');
  }

  function parseRichText(inner) {
    const rt = [];
    let bold = false, italic = false, code = false;
    const re = /(<(\/?)(?:strong|b|em|i|code)\b[^>]*>)|(<[^>]+>)|([^<]+)/gi;
    let m;
    while ((m = re.exec(inner)) !== null) {
      if (m[1]) {
        const closing = m[2] === '/';
        const tag = (m[1].match(/<\/?(\w+)/) || [])[1]?.toLowerCase();
        if (tag === 'strong' || tag === 'b') bold = !closing;
        else if (tag === 'em' || tag === 'i') italic = !closing;
        else if (tag === 'code') code = !closing;
      } else if (m[4]) {
        const text = decode(m[4]);
        if (!text) continue;
        for (let i = 0; i < text.length; i += MAX) {
          const item = { type: 'text', text: { content: text.slice(i, i + MAX) } };
          const ann = {};
          if (bold) ann.bold = true;
          if (italic) ann.italic = true;
          if (code) ann.code = true;
          if (Object.keys(ann).length) item.annotations = ann;
          rt.push(item);
        }
      }
    }
    return rt.filter(r => r.text.content.trim());
  }

  function push(type, inner) {
    if (blocks.length >= 95) return;
    const rt = parseRichText(inner.replace(/<br\s*\/?>/gi, ' '));
    if (!rt.length) return;
    const plain = rt.map(r => r.text.content).join('').trim();
    if (plain.length < 3) return;
    blocks.push({ object: 'block', type, [type]: { rich_text: rt } });
  }

  // Emit a chunk of HTML that may contain embedded sentinels for lists/headings
  function emitChunk(chunk, defaultType = 'paragraph') {
    // Split on embedded sentinels: \x00<idx>\x00
    const parts = chunk.split(/\x00(\d+)\x00/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Split text segment further on <br><br> paragraph breaks
        for (const sub of parts[i].split(/(?:<br\s*\/?>\s*){2,}/i)) {
          const plain = decode(sub.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
          if (plain.length >= 3) push(defaultType, sub);
        }
      } else {
        // Sentinel index — emit the stored segment
        emitSegment(parseInt(parts[i]));
      }
    }
  }

  const segments = []; // stored structured blocks extracted in pass 1

  function emitSegment(idx) {
    const seg = segments[idx];
    if (!seg) return;
    if (seg.type === 'list') {
      for (const item of seg.items) emitChunk(item, 'bulleted_list_item');
    } else if (seg.type === 'heading') {
      const type = seg.level === 1 ? 'heading_1' : seg.level === 2 ? 'heading_2' : 'heading_3';
      push(type, seg.inner);
    }
  }

  // Strip non-content elements
  html = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/<input\b[^>]*>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');

  // Prefer <main> for full-page HTML
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) html = mainMatch[1];

  // Pass 1: extract <ul>/<ol> list items (replace with sentinel \x00idx\x00)
  html = html.replace(/<(?:ul|ol)\b[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi, (_, content) => {
    const items = [...content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map(m => m[1]);
    if (!items.length) return '';
    const idx = segments.length;
    segments.push({ type: 'list', items });
    return `\x00${idx}\x00`;
  });

  // Pass 2: extract headings (replace with sentinel)
  html = html.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, tag, inner) => {
    const idx = segments.length;
    segments.push({ type: 'heading', level: parseInt(tag[1]), inner });
    return `\x00${idx}\x00`;
  });

  // Pass 3: process remaining HTML — split into paragraph-sized chunks
  // <br><br>+ acts as a paragraph break; <p>...</p> is an explicit paragraph
  const chunks = [];

  // Find explicit <p> blocks and text between them (which may be <br>-delimited)
  let rest = html;

  // Replace <p>...</p> and <div>...</div> with sentinels and collect the in-between text.
  // Matching both lets us handle CMS content that uses <div> as block separators instead of <p>.
  // Non-greedy match means nested divs each produce a separate chunk (outer captures content
  // only up to the first inner closing tag).
  const pRe = /<(?:p|div)\b[^>]*>([\s\S]*?)<\/(?:p|div)\s*>/gi;
  let last = 0;
  for (const m of [...rest.matchAll(pRe)]) {
    // Text before this <p>: split on <br><br> for implicit paragraphs
    const before = rest.slice(last, m.index);
    for (const seg of before.split(/(?:<br\s*\/?>\s*){2,}/i)) chunks.push({ html: seg, type: 'paragraph' });
    // The <p> content itself
    chunks.push({ html: m[1], type: 'paragraph' });
    last = m.index + m[0].length;
  }
  // Tail after last <p>
  const tail = rest.slice(last);
  for (const seg of tail.split(/(?:<br\s*\/?>\s*){2,}/i)) chunks.push({ html: seg, type: 'paragraph' });

  // Pass 4: emit all chunks
  for (const { html: chunk, type } of chunks) {
    if (blocks.length >= 95) break;
    emitChunk(chunk, type);
  }

  return blocks;
}

function plainTextToNotionBlocks(text) {
  const MAX = 2000;
  const blocks = [];

  function para(content) {
    if (!content || blocks.length >= 95) return;
    for (let i = 0; i < content.length; i += MAX) {
      if (blocks.length >= 95) break;
      blocks.push({ object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: content.slice(i, i + MAX) } }] } });
    }
  }

  function heading(content) {
    if (!content || blocks.length >= 95) return;
    blocks.push({ object: 'block', type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: content.slice(0, MAX) } }] } });
  }

  function bullet(content) {
    if (!content || blocks.length >= 95) return;
    blocks.push({ object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: content.slice(0, MAX) } }] } });
  }

  // Sections where the body text is a list of items (sentences → bullets)
  const LIST_SECTION = /^(responsibilities|requirements|qualifications|what you may need|need to be successful|key responsibilities|your responsibilities)/i;

  // Pre-process: split on embedded section headers so each appears on its own line
  let normalised = text
    // "end. Header: start" — colon-terminated headers (max 40 chars before colon)
    .replace(/\.\s+([A-Z][^.:!?\n]{3,40}:)\s+/g, ".\n$1\n")
    // "end. Why Join Us?" — question-mark headers
    .replace(/\.\s+([A-Z][^.:!?\n]{5,60}\?)\s+/g, ".\n$1\n")
    // Known no-colon headers common in Workday JDs
    .replace(/\.\s+(What You.ll Do)\s+/g, ".\nWhat You'll Do\n")
    .replace(/\.\s+(About [A-Z][A-Za-z ]{2,25})\s+(?=[A-Z])/g, ".\n$1\n")
    // Middle-dot and standard bullets
    .replace(/\s*[·•]\s*/g, "\n• ")
    .replace(/\n[-*]\s+/g, "\n• ");

  const lines = normalised.split('\n').map(l => l.trim()).filter(Boolean);

  let inListSection = false;

  for (const line of lines) {
    if (blocks.length >= 95) break;

    if (line.startsWith('• ')) {
      inListSection = false;
      bullet(line.slice(2).trim());
      continue;
    }

    // Detect section headers: standalone short phrase ending with ":" or "?"
    const headerMatch = line.match(/^([A-Z][^.:!?]{2,70})[?:]$/);
    if (headerMatch) {
      const label = headerMatch[1].trim();
      heading(label);
      inListSection = LIST_SECTION.test(label);
      continue;
    }

    // In a list-type section, split content into individual bullet sentences
    if (inListSection) {
      const sentences = line.split(/\.\s+(?=[A-Z])/).map(s => s.replace(/\.$/, '').trim()).filter(Boolean);
      if (sentences.length > 1) {
        sentences.forEach(s => bullet(s));
        inListSection = false;
        continue;
      }
    }

    inListSection = false;
    para(line);
  }

  return blocks;
}

app.post('/api/tracker/save', express.json({ limit: '5mb' }), async (req, res) => {
  const { url, role, company, stage, pageHtml } = req.body || {};
  if (!url || !company || !stage)
    return res.status(400).json({ error: 'url, company, and stage are required' });
  if (!process.env.NOTION_TOKEN)
    return res.status(503).json({ error: 'notion_not_configured' });
  try {
    const topBlocks = await fetchAllNotionBlocks(NOTION_PAGE_ID);
    const stagePage = topBlocks.find(b => {
      if (b.type !== 'child_page') return false;
      return b.child_page.title.toLowerCase() === stage.toLowerCase();
    });
    if (!stagePage)
      return res.status(404).json({ error: `No Notion page found for stage "${stage}"` });

    const linkText = '[🔗 link]';
    const bodyText = role ? ` — ${role} | ${company}` : ` — ${company}`;

    // Extract job description content for Notion.
    // Prefer HTML sent directly by the extension (authenticated, fully rendered DOM).
    // Fall back to server-side fetch for non-SPA pages or when scripting is unavailable.
    let children = [];
    try {
      if (pageHtml) {
        children = htmlToNotionBlocks(pageHtml);
      } else {
        const html = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          signal: AbortSignal.timeout(8000),
        }).then(r => r.text());

        let ldPlainText = '';
        const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
        if (ldMatch) {
          try {
            const ld = JSON.parse(ldMatch[1]);
            const posting = Array.isArray(ld)
              ? ld.find(x => x['@type'] === 'JobPosting')
              : ld['@type'] === 'JobPosting' ? ld : null;
            if (posting?.description) {
              if (/<[a-z]/i.test(posting.description)) {
                children = htmlToNotionBlocks(posting.description);
              } else {
                ldPlainText = posting.description;
              }
            }
          } catch { /* malformed JSON-LD */ }
        }

        if (!children.length) children = htmlToNotionBlocks(html);

        if (!children.length && ldPlainText) children = plainTextToNotionBlocks(ldPlainText);
      }
    } catch { /* fetch failed — save without description */ }

    const page = await notionFetch('pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { page_id: stagePage.id },
        properties: {
          title: {
            title: [
              { type: 'text', text: { content: linkText, link: { url } } },
              { type: 'text', text: { content: bodyText } },
            ],
          },
        },
        ...(children.length ? { children } : {}),
      }),
    });

    urlMapCache = null; // force extension to re-fetch
    res.json({ ok: true, pageId: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- Tracker routes --

app.get('/api/tracker/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(400).send('Set GOOGLE_CLIENT_ID in your environment first.');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: GMAIL_REDIRECT,
    response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/api/tracker/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, redirect_uri: GMAIL_REDIRECT, grant_type: 'authorization_code',
        client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    });
    const token = await r.json();
    if (!r.ok) throw new Error(token.error_description || token.error);
    token.expiry_date = Date.now() + (token.expires_in || 3600) * 1000;
    saveGmailToken(token);
    res.send('<p style="font-family:sans-serif;padding:40px">Gmail authorised ✓ — you can close this tab.</p>');
  } catch (e) { res.status(500).send('Auth failed: ' + e.message); }
});

app.get('/api/tracker/load', async (req, res) => {
  const result = { applications: [], setup: { notion: 'ok', gmail: 'ok' } };
  try {
    result.applications = await loadNotionApps();
  } catch (e) {
    result.setup.notion = e.code || 'error';
  }
  try {
    const access = await getGmailAccessToken();
    const gmailApps = await fetchGmailApps(GMAIL_QUERY_FULL);
    result.applications = mergeGmailIntoNotion(result.applications, gmailApps);
    await enrichEmailDates(result.applications, access);
  } catch (e) {
    result.setup.gmail = e.code || 'error';
  }
  res.json(result);
});

app.get('/api/tracker/refresh', async (req, res) => {
  const result = { applications: [], setup: { notion: 'ok', gmail: 'ok' } };
  try {
    result.applications = await loadNotionApps();
  } catch (e) {
    result.setup.notion = e.code || 'error';
  }
  try {
    const access = await getGmailAccessToken();
    const gmailApps = await fetchGmailApps(GMAIL_QUERY_DAY);
    result.applications = mergeGmailIntoNotion(result.applications, gmailApps);
    await enrichEmailDates(result.applications, access);
  } catch (e) {
    result.setup.gmail = e.code || 'error';
  }
  res.json(result);
});

// -- Detail panel: Notion content + Gmail threads for one company --

function extractEmailBody(payload) {
  if (!payload) return null;
  const mime = payload.mimeType || '';
  if (mime === 'text/html' && payload.body?.data)
    return { html: true, content: Buffer.from(payload.body.data, 'base64url').toString('utf8') };
  if (mime === 'text/plain' && payload.body?.data)
    return { html: false, content: Buffer.from(payload.body.data, 'base64url').toString('utf8') };
  // Multipart: recurse, prefer HTML
  const parts = payload.parts || [];
  let plain = null;
  for (const part of parts) {
    const r = extractEmailBody(part);
    if (r?.html) return r;
    if (r && !plain) plain = r;
  }
  return plain;
}

function stripHtmlQuotes(html) {
  // Remove style/script blocks that marketing emails inject into the body
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Cut at the first quote block — everything after is thread history
  let cutAt = html.length;
  for (const p of [/<div class="gmail_quote/i, /<blockquote\b/i, /<div id="appendonsend"/i]) {
    const i = html.search(p);
    if (i > 0 && i < cutAt) cutAt = i;
  }
  return html.slice(0, cutAt).trim();
}

function stripPlainQuotes(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.startsWith('>')) continue;
    if (/^On .{10,200} wrote:$/.test(line.trim())) continue;
    out.push(line);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.join('\n');
}

function stripTemplateVars(s) {
  return s.replace(/\{\{[^}]*\}\}/g, '').replace(/\{%[^%]*%\}/g, '');
}

function sanitizeEmailHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"')
    .replace(/src\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '');
}

function emailBodyToHtml(bodyResult, snippet) {
  if (!bodyResult) return escHtml(snippet || '');
  if (bodyResult.html) {
    let h = bodyResult.content;
    const bodyMatch = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) h = bodyMatch[1];
    return sanitizeEmailHtml(stripTemplateVars(stripHtmlQuotes(h)));
  }
  const stripped = stripPlainQuotes(bodyResult.content);
  return `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${escHtml(stripTemplateVars(stripped || bodyResult.content))}</pre>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function richTextToHtml(richText) {
  return (richText || []).map(span => {
    let text = escHtml(span.plain_text || '');
    if (!text) return '';
    const a = span.annotations || {};
    if (a.bold)          text = `<strong>${text}</strong>`;
    if (a.italic)        text = `<em>${text}</em>`;
    if (a.strikethrough) text = `<s>${text}</s>`;
    if (a.code)          text = `<code>${text}</code>`;
    if (span.href)       text = `<a href="${escHtml(span.href)}" target="_blank" rel="noopener">${text}</a>`;
    return text;
  }).join('');
}

function blocksToHtml(blocks) {
  let html = '';
  let inUl = false, inOl = false;
  const closeList = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  for (const block of blocks) {
    const type = block.type;
    const content = block[type];
    if (!content) continue;
    if (type !== 'bulleted_list_item') { if (inUl) { html += '</ul>'; inUl = false; } }
    if (type !== 'numbered_list_item') { if (inOl) { html += '</ol>'; inOl = false; } }
    const t = richTextToHtml(content.rich_text);
    switch (type) {
      case 'heading_1': html += `<h2>${t}</h2>`; break;
      case 'heading_2': html += `<h3>${t}</h3>`; break;
      case 'heading_3': html += `<h4>${t}</h4>`; break;
      case 'paragraph': html += t ? `<p>${t}</p>` : '<p>&nbsp;</p>'; break;
      case 'bulleted_list_item':
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li>${t}</li>`; break;
      case 'numbered_list_item':
        if (!inOl) { html += '<ol>'; inOl = true; }
        html += `<li>${t}</li>`; break;
      case 'divider': closeList(); html += '<hr>'; break;
      case 'code':
        html += `<pre><code>${escHtml((content.rich_text || []).map(r => r.plain_text).join(''))}</code></pre>`; break;
      case 'quote': html += `<blockquote>${t}</blockquote>`; break;
      case 'callout': html += `<div class="notion-callout">${t}</div>`; break;
    }
  }
  closeList();
  return html;
}

app.get('/api/tracker/detail', async (req, res) => {
  const { notionPageId, company } = req.query;
  const result = { jobDescription: '', emails: [] };

  // Notion job description + job posting URL from page title rich text
  if (notionPageId) {
    try {
      const [blocks, page] = await Promise.all([
        fetchAllNotionBlocks(notionPageId),
        fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
          headers: { 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
        }).then(r => r.json()),
      ]);
      result.jobDescription = blocksToHtml(blocks);
      // Title rich text may contain a hyperlink on the 🔗 portion
      const titleSpans = page.properties?.title?.title || [];
      for (const span of titleSpans) {
        const url = span.href || (span.plain_text?.match(/https?:\/\/\S+/)?.[0]);
        if (url) { result.jobUrl = url; break; }
      }
    } catch (e) {
      result.jobDescriptionError = e.message;
    }
  }

  // Gmail threads mentioning this company (and role if provided)
  if (company) {
    try {
      const access = await getGmailAccessToken();
      const profile = await gmailApiFetch('users/me/profile', access);
      const myEmail = (profile.emailAddress || '').toLowerCase();

      const { role } = req.query;
      const roleKeywords = roleBodyKeywords(role);
      const companyTerm = cleanCompanyTerm(company);
      const roleTerm = roleSearchTerm(role);
      // Use subject: so a company name appearing only in an email body (e.g. LinkedIn "top jobs" sections) doesn't pollute another company's panel
      const q = buildJobEmailQuery(companyTerm, roleTerm);
      const list = await gmailApiFetch(
        `users/me/threads?q=${encodeURIComponent(q)}&maxResults=50`, access);
      await Promise.all((list.threads || []).map(async ({ id }) => {
        try {
          const thread = await gmailApiFetch(`users/me/threads/${id}?format=full`, access);
          const msgs = thread.messages || [];
          for (const msg of msgs) {
            const hdrs = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name, h.value]));
            const from = hdrs['From'] || '';
            const subj = hdrs['Subject'] || '(no subject)';
            const bodyResult = extractEmailBody(msg.payload);
            // Post-filter: if the body mentions some but not all of this role's keywords,
            // it belongs to a different role at the same company — skip it.
            const bodyText = bodyResult
              ? (bodyResult.html
                  ? bodyResult.content.replace(/<[^>]+>/g, ' ')
                  : bodyResult.content)
              : (msg.snippet || '');
            if (!emailMatchesRole(subj + ' ' + bodyText, roleKeywords)) continue;
            const isCalendar = /calendar-notification@google\.com|calendly\.com|@calendly\b/i.test(from) ||
              /\.ics|calendar invite|interview.*scheduled|scheduled.*interview|^appointment booked|^invitation from (an? )?unknown sender|^invitation for .*(call|meeting|interview)|^reminder:.*(call|meeting|interview|@)/i.test(subj);
            result.emails.push({
              subject: subj,
              from,
              date: msg.internalDate ? new Date(+msg.internalDate).toISOString().split('T')[0] : null,
              ts: +msg.internalDate || 0,
              bodyHtml: emailBodyToHtml(bodyResult, msg.snippet),
              isOutgoing: myEmail && from.toLowerCase().includes(myEmail),
              isCalendar,
            });
          }
        } catch { /* skip */ }
      }));
      result.emails.sort((a, b) => b.ts - a.ts);
    } catch (e) {
      result.emailsError = e.code || e.message;
    }
  }

  res.json(result);
});

// Bind to loopback only — this app serves your private answers with no auth,
// so it must never be reachable from other machines on the network.
app.listen(PORT, '127.0.0.1', () => console.log(`Job Tracker running at http://localhost:${PORT}`));
