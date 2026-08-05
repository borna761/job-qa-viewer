// Extension files (background.js, popup.js) aren't written as CommonJS
// modules meant to be require()'d repeatedly — they're loaded once per
// browser session and hold module-level mutable state (background.js's
// urlMap/serverOnline/fetchInFlight, its icon caches). Node caches
// require() results, so reusing the cached instance across tests would leak
// state between them. freshRequire() deletes the cache entry first so every
// call gets an independent instance — the same trick you'd reach for
// testing any stateful singleton module.
const path = require('path');
const EXT_DIR = path.join(__dirname, '..', 'extension');

function freshRequire(filename) {
  const full = path.join(EXT_DIR, filename);
  delete require.cache[require.resolve(full)];
  return require(full);
}

module.exports = { freshRequire, EXT_DIR };
