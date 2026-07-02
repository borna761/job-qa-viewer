const express = require('express');
const fs = require('fs');
const path = require('path');

// ./lib/config loads .env on require, before any process.env reads.
const { PORT, DATA_DIR, GENERAL_FILE } = require('./lib/config');
const { parseQA, serializeQA, readTxtFile, pairId, displayName, nameToSlug } = require('./lib/qa');
const { loadConfig, saveConfig, loadOrder, saveOrder, getAll } = require('./lib/store');
const {
  notionFetch, fetchAllNotionBlocks, loadNotionApps,
  getUrlMapCached, invalidateUrlMapCache,
} = require('./lib/notion');
const {
  getGmailAccessToken, gmailApiFetch, saveGmailToken,
  GMAIL_REDIRECT, GMAIL_QUERY_FULL, GMAIL_QUERY_DAY,
} = require('./lib/gmail');
const {
  fetchGmailApps, mergeGmailIntoNotion, enrichEmailDates,
  roleBodyKeywords, cleanCompanyTerm, roleSearchTerm, buildJobEmailQuery,
  extractEmailBody, emailMatchesRole, localDateStr, emailBodyToHtml,
} = require('./lib/email');
const {
  htmlToNotionBlocks, plainTextToNotionBlocks, blocksToHtml,
  isAllowedEmbeddedJobUrl, fetchAndExtractBlocks,
} = require('./lib/notionHtml');

const app = express();

// ---- Q&A routes ----

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

// ---- Tracker (Notion + Gmail) routes ----

app.get('/api/tracker/urls', async (req, res) => {
  // No CORS header by design: the Chrome extension reaches this endpoint through
  // its host_permissions for localhost, so it doesn't need Access-Control-Allow-Origin.
  // Omitting the wildcard stops arbitrary websites the user visits from reading
  // their tracked application list (companies, stages, job URLs).
  if (!process.env.NOTION_TOKEN)
    return res.status(503).json({ error: 'notion_not_configured' });
  try {
    res.json(await getUrlMapCached(!!req.query.force));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tracker/save', express.json({ limit: '5mb' }), async (req, res) => {
  const { url, role, company, stage, pageHtml, pageHtmlTargeted, embeddedJobUrl } = req.body || {};
  if (!url || !company || !stage)
    return res.status(400).json({ error: 'url, company, and stage are required' });
  if (!process.env.NOTION_TOKEN)
    return res.status(503).json({ error: 'notion_not_configured' });
  try {
    const topBlocks = await fetchAllNotionBlocks(process.env.NOTION_PAGE_ID);
    const stagePage = topBlocks.find(b => {
      if (b.type !== 'child_page') return false;
      return b.child_page.title.toLowerCase() === stage.toLowerCase();
    });
    if (!stagePage)
      return res.status(404).json({ error: `No Notion page found for stage "${stage}"` });

    const linkText = '[🔗 link]';
    const bodyText = role ? ` — ${role} | ${company}` : ` — ${company}`;

    // Extract job description content for Notion.
    let children = [];
    try {
      // 1. Trust the extension's rendered DOM when it came from a targeted
      //    selector (LinkedIn/Greenhouse/etc.) — fast, no extra fetch. A missing
      //    flag is treated as targeted for backward compatibility with older
      //    extension builds.
      if (pageHtml && pageHtmlTargeted !== false) {
        children = htmlToNotionBlocks(pageHtml);
      }

      // 2. If the page embeds a known ATS's hosted job page in an iframe (e.g.
      //    a company careers page embedding Ashby/Greenhouse/Lever/Workday),
      //    that iframe's own URL is a real, directly-fetchable page — try it
      //    before the top-level page, which is usually just marketing/culture
      //    content with no job-specific data at all.
      if (!children.length && embeddedJobUrl && isAllowedEmbeddedJobUrl(embeddedJobUrl))
        children = await fetchAndExtractBlocks(embeddedJobUrl);

      // 3. Otherwise (extension fell back to a greedy whole-page grab, or sent
      //    nothing): fetch the page server-side and prefer a clean JobPosting
      //    JSON-LD description. This rescues career-site SPAs (e.g. Phenom) whose
      //    DOM is mostly nav/widgets. Sites that block server fetch (LinkedIn)
      //    just fall through to the extension's pageHtml below.
      if (!children.length) children = await fetchAndExtractBlocks(url);

      // 4. Last resort: a greedy pageHtml grab is still better than nothing.
      if (!children.length && pageHtml) children = htmlToNotionBlocks(pageHtml);
    } catch { /* save without description */ }

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

    invalidateUrlMapCache(); // force extension to re-fetch
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
              date: msg.internalDate ? localDateStr(+msg.internalDate) : null,
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
// Only listen when run directly (`node server.js`); when required by tests,
// just export the app so they can mount it on an ephemeral port.
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`Job Tracker running at http://localhost:${PORT}`));
}

module.exports = app;
