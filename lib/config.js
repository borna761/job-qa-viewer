// Shared paths and server config. All file paths are resolved relative to the
// project root (one level up from lib/) so modules don't depend on their own
// __dirname.
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT:            process.env.PORT || 3456,
  DATA_DIR:        path.join(ROOT, 'data'),
  GENERAL_FILE:    path.join(ROOT, 'data', 'answers.txt'),
  ORDER_FILE:      path.join(ROOT, 'order.json'),
  CONFIG_FILE:     path.join(ROOT, 'config.json'),
  GMAIL_TOKEN_FILE: path.join(ROOT, 'gmail-token.json'),
};
