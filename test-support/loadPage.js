// app.js/tracker.js are loaded via plain <script> tags in index.html (no
// module system, no bundler) and hold module-level mutable state — same
// situation extension/popup.js was in. Rather than hand-rolling a fake DOM,
// this loads the real index.html into jsdom so every element ID the scripts
// reference actually exists, exactly as it does in the real page.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { freshRequireAbsolute } = require('./freshRequireAbsolute');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function freshRequire(file) {
  return freshRequireAbsolute(path.join(ROOT, file));
}

// jsdom parses <script> tags but never executes them (no runScripts option
// set), so the CDN Sortable.js / app.js / tracker.js tags in index.html are
// inert — the modules are require()'d directly afterward instead, with
// their globals already in place, mirroring real load order.
async function loadPage({ fetchMock, url = 'http://localhost:3456/' } = {}) {
  const dom = new JSDOM(HTML, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.CSS = dom.window.CSS || { escape: s => String(s).replace(/[^a-zA-Z0-9_-]/g, m => '\\' + m) };
  global.requestAnimationFrame = dom.window.requestAnimationFrame || (cb => setTimeout(cb, 0));
  // jsdom doesn't implement actual layout, so these throw "Not implemented"
  // by default — real code calls them purely for their side effect (moving
  // the viewport), which has no observable meaning in a DOM with no layout
  // anyway, so a no-op stub is exactly correct here, not a workaround.
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  // Real Sortable.js needs a real drag gesture to do anything; drag-and-drop
  // reordering itself isn't covered here (low value to simulate, see the
  // functions actually exported from app.js) — this stub only needs to not
  // throw when render()/renderSettingsModal() call Sortable.create().
  global.Sortable = { create: () => ({ destroy() {} }) };
  global.fetch = fetchMock || (async () => ({ ok: true, json: async () => ({}) }));

  return dom;
}

// Flushes the microtask queue — needed after loadPage() for app.js, whose
// bottom-of-file init fetch runs unconditionally at require() time, and
// after triggering any deep fetch(...).then().then() chain in a test. A
// setTimeout(0) macrotask runs after every currently-queued microtask,
// however many hops the chain has, which is more robust than guessing a
// fixed number of `await Promise.resolve()` ticks.
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

module.exports = { loadPage, freshRequire, flush };
