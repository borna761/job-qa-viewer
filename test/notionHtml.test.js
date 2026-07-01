const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escHtml, richTextToHtml, blocksToHtml,
  htmlToNotionBlocks, plainTextToNotionBlocks,
  extractJobPostingDescription, descriptionToBlocks,
} = require('../lib/notionHtml');

test('escHtml escapes the HTML-significant characters', () => {
  assert.equal(escHtml('<a href="x" & y>'), '&lt;a href=&quot;x&quot; &amp; y&gt;');
});

test('richTextToHtml applies annotations and escapes content', () => {
  assert.equal(richTextToHtml([{ plain_text: 'hi', annotations: { bold: true } }]), '<strong>hi</strong>');
  assert.equal(richTextToHtml([{ plain_text: '<b>', annotations: {} }]), '&lt;b&gt;');
  assert.match(
    richTextToHtml([{ plain_text: 'link', href: 'https://x.test' }]),
    /^<a href="https:\/\/x\.test" target="_blank" rel="noopener">link<\/a>$/,
  );
});

test('blocksToHtml renders paragraphs and wraps bulleted lists', () => {
  assert.equal(
    blocksToHtml([{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello' }] } }]),
    '<p>Hello</p>',
  );
  const list = blocksToHtml([
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'one' }] } },
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'two' }] } },
  ]);
  assert.equal(list, '<ul><li>one</li><li>two</li></ul>');
});

test('htmlToNotionBlocks turns a paragraph into a paragraph block', () => {
  const blocks = htmlToNotionBlocks('<p>Hello world this is the job description.</p>');
  assert.equal(blocks[0].type, 'paragraph');
  const text = blocks[0].paragraph.rich_text.map(r => r.text.content).join('');
  assert.match(text, /Hello world this is the job description/);
});

test('htmlToNotionBlocks turns list items into bulleted_list_item blocks', () => {
  const blocks = htmlToNotionBlocks('<ul><li>First responsibility here</li><li>Second responsibility here</li></ul>');
  const bullets = blocks.filter(b => b.type === 'bulleted_list_item');
  assert.equal(bullets.length, 2);
});

test('plainTextToNotionBlocks emits paragraph blocks for prose', () => {
  const blocks = plainTextToNotionBlocks('We are hiring a product manager to own the roadmap.');
  assert.ok(blocks.length >= 1);
  assert.equal(blocks[0].type, 'paragraph');
});

test('htmlToNotionBlocks handles a mix of heading, list, and paragraph', () => {
  const html =
    '<h2>Responsibilities</h2>' +
    '<ul><li>Own the roadmap end to end</li><li>Talk to customers weekly</li></ul>' +
    '<p>We move fast and iterate constantly.</p>';
  const blocks = htmlToNotionBlocks(html);
  assert.ok(blocks.some(b => b.type.startsWith('heading_')));
  assert.equal(blocks.filter(b => b.type === 'bulleted_list_item').length, 2);
  assert.ok(blocks.some(b => b.type === 'paragraph'));
});

test('htmlToNotionBlocks preserves bold annotations in rich text', () => {
  const blocks = htmlToNotionBlocks('<p>This is <strong>very important</strong> to remember here.</p>');
  const rich = blocks[0].paragraph.rich_text;
  assert.ok(rich.some(seg => seg.annotations && seg.annotations.bold));
});

test('htmlToNotionBlocks caps output at 95 blocks (Notion children limit)', () => {
  const many = Array.from({ length: 200 }, (_, i) => `<p>Paragraph number ${i} with plenty of text.</p>`).join('');
  assert.ok(htmlToNotionBlocks(many).length <= 95);
});

test('htmlToNotionBlocks chunks text longer than 2000 chars into multiple rich-text runs', () => {
  const blocks = htmlToNotionBlocks(`<p>${'x'.repeat(5000)}</p>`);
  const rich = blocks[0].paragraph.rich_text;
  assert.ok(rich.length >= 3);
  assert.ok(rich.every(seg => seg.text.content.length <= 2000));
});

// A page like careers.evercommerce.com: multiple ld+json blocks, the JobPosting
// is NOT first, and its description is entity-encoded HTML.
const JOBPAGE_HTML = `
<html><head>
<script type="application/ld+json">{"@type":"WebSite","name":"Careers"}</script>
<script type="application/ld+json">{"@type":"JobPosting","title":"Product Manager",
"description":"&lt;p&gt;About the Role&lt;br /&gt;We are hiring a PM to own the roadmap.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Ship product end to end&lt;/li&gt;&lt;li&gt;Talk to customers weekly&lt;/li&gt;&lt;/ul&gt;"}</script>
</head><body><nav>Apply Now</nav><section>Similar Jobs ...</section></body></html>`;

test('extractJobPostingDescription finds JobPosting in any ld+json block and decodes entity tags', () => {
  const desc = extractJobPostingDescription(JOBPAGE_HTML);
  assert.match(desc, /<p>/);
  assert.match(desc, /<li>Ship product end to end<\/li>/);
  assert.doesNotMatch(desc, /&lt;/);
});

test('extractJobPostingDescription returns empty string when no JobPosting present', () => {
  assert.equal(extractJobPostingDescription('<html><script type="application/ld+json">{"@type":"WebSite"}</script></html>'), '');
  assert.equal(extractJobPostingDescription('<html>no structured data</html>'), '');
});

test('descriptionToBlocks turns a JobPosting description into clean blocks without page chrome', () => {
  const blocks = descriptionToBlocks(extractJobPostingDescription(JOBPAGE_HTML));
  assert.ok(blocks.length >= 1);
  assert.equal(blocks.filter(b => b.type === 'bulleted_list_item').length, 2);
  const allText = blocks.map(b => (b[b.type].rich_text || []).map(r => r.text.content).join('')).join(' ');
  assert.doesNotMatch(allText, /Apply Now|Similar Jobs/);
});
