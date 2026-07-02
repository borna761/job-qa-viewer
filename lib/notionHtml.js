// HTML <-> Notion-block conversion.
//  - htmlToNotionBlocks / plainTextToNotionBlocks: job-posting HTML or text
//    into Notion blocks when saving from the extension.
//  - blocksToHtml / richTextToHtml / escHtml: Notion blocks back into HTML
//    for the detail panel.

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

  // Strip non-content elements. <head> and <noscript> matter when this runs
  // on a full fetched document (a client-rendered SPA whose server response is
  // just an empty shell): without stripping them, the <title> text and the
  // "enable JavaScript" fallback message are the only text left, and get
  // saved as if they were the real job description.
  html = html
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
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

  // Normalise block-level divs to paragraphs so the <p> splitter below handles them.
  // Runs after list/heading extraction so sentinels are already in place.
  html = html.replace(/<div\b[^>]*>/gi, '<p>').replace(/<\/div\s*>/gi, '</p>');

  // Find explicit <p> blocks and text between them (which may be <br>-delimited)
  let rest = html;

  // Replace <p>...</p> with sentinels and collect the in-between text
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
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

// Expose entity-encoded HTML tags (e.g. JSON-LD often stores `&lt;p&gt;`).
// Only the structural < > are decoded here; htmlToNotionBlocks decodes the rest
// of the entities inside text nodes.
function decodeEntityTags(s) {
  return s
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#0*60;/g, '<').replace(/&#0*62;/g, '>');
}

// Pull a clean job description out of a page's embedded JobPosting JSON-LD.
// Career-site SPAs (Phenom, Workday, Greenhouse, …) expose this even when their
// rendered DOM is buried in nav/widgets. Scans every ld+json block (the
// JobPosting is not always the first) and handles plain objects, arrays, and
// @graph. Returns '' when none is found.
function extractJobPostingDescription(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let json;
    try { json = JSON.parse(m[1]); } catch { continue; }
    const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
    for (const node of nodes) {
      if (node && node['@type'] === 'JobPosting' && node.description)
        return decodeEntityTags(String(node.description));
    }
  }
  return '';
}

// Convert a job-description string (HTML or plain text) into Notion blocks.
function descriptionToBlocks(description) {
  if (!description) return [];
  return /<[a-z]/i.test(description)
    ? htmlToNotionBlocks(description)
    : plainTextToNotionBlocks(description);
}

// ATS hosts we'll follow an extension-reported embedded-iframe URL to (see
// server.js's /api/tracker/save). The extension only ever reports the src of
// an <iframe> it found in the page, but the server treats client input as
// untrusted regardless — a proper subdomain check, not just a suffix match,
// so a lookalike like "evilashbyhq.com" can't sneak through.
const EMBEDDABLE_ATS_HOSTS = ['ashbyhq.com', 'greenhouse.io', 'lever.co', 'myworkday.com'];
function isAllowedEmbeddedJobUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:') return false;
    return EMBEDDABLE_ATS_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Fetch a URL server-side and extract job-description blocks from it: prefer
// a clean JobPosting JSON-LD description, falling back to converting the
// full fetched HTML. Returns [] if the fetch fails or nothing is found.
async function fetchAndExtractBlocks(targetUrl) {
  let html = '';
  try {
    html = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    }).then(r => r.text());
  } catch { /* fetch blocked/failed */ }
  if (!html) return [];
  const desc = extractJobPostingDescription(html);
  if (desc.length > 400) return descriptionToBlocks(desc);
  return htmlToNotionBlocks(html);
}

module.exports = {
  htmlToNotionBlocks, plainTextToNotionBlocks,
  blocksToHtml, richTextToHtml, escHtml,
  extractJobPostingDescription, descriptionToBlocks,
  isAllowedEmbeddedJobUrl, fetchAndExtractBlocks,
};
