// Shared paths and server config. Loads .env here (before reading process.env)
// so any consumer of this module gets correct values regardless of which entry
// point required it or in what order. All file paths resolve relative to the
// project root (one level up from lib/).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Load .env file if present (KEY=value, ignores comments and blank lines).
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
} catch { /* .env is optional */ }

module.exports = {
  ROOT,
  PORT:            process.env.PORT || 3456,
  DATA_DIR:        path.join(ROOT, 'data'),
  GENERAL_FILE:    path.join(ROOT, 'data', 'answers.txt'),
  ORDER_FILE:      path.join(ROOT, 'order.json'),
  CONFIG_FILE:     path.join(ROOT, 'config.json'),
  GMAIL_TOKEN_FILE: path.join(ROOT, 'gmail-token.json'),
};
