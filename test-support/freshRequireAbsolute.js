// Cache-busting require() against an absolute path — the shared core behind
// loadExtensionModule.js's and loadPage.js's own freshRequire() helpers,
// which otherwise duplicated this identically apart from which base
// directory (extension/ vs repo root) they resolved a relative path against.
function freshRequireAbsolute(absolutePath) {
  delete require.cache[require.resolve(absolutePath)];
  return require(absolutePath);
}

module.exports = { freshRequireAbsolute };
