const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escHtml, richTextToHtml, blocksToHtml,
  htmlToNotionBlocks, plainTextToNotionBlocks,
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
