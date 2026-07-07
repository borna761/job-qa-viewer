// Gmail email handling: classifying threads, extracting company/role, building
// search queries, merging Gmail signal into Notion apps, enriching dates, and
// extracting/sanitising/rendering email bodies for the detail panel.
const { getGmailAccessToken, gmailApiFetch } = require('./gmail');
const { escHtml } = require('./notionHtml');

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

function localDateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

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
const GMAIL_EXCLUDE = '-from:jobalerts-noreply@linkedin.com -from:hit-noreply@linkedin.com -from:notifications-noreply@linkedin.com -from:indeed.com -from:glassdoor.com -from:ziprecruiter.com -from:monster.com -from:careerbuilder.com -from:jobgether.com -category:promotions';

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

module.exports = {
  localDateStr, extractCompanyFromSubject, isLikelyRole, extractCompany,
  classifyThread, fetchGmailApps, buildPrimaryByCompany, mergeGmailIntoNotion,
  extractRoleWords, roleSearchTerm, roleBodyKeywords, cleanCompanyTerm,
  buildJobEmailQuery, emailMatchesRole, enrichEmailDates,
  extractEmailBody, stripHtmlQuotes, stripPlainQuotes, stripTemplateVars,
  sanitizeEmailHtml, emailBodyToHtml,
};
