// Gmail OAuth (refresh-token flow) and a thin API-fetch helper.
const fs = require('fs');
const { GMAIL_TOKEN_FILE, PORT } = require('./config');

const GMAIL_REDIRECT   = `http://localhost:${PORT}/api/tracker/auth/callback`;
const GMAIL_QUERY_FULL = 'subject:(application OR interview OR offer OR recruiter OR hiring) newer_than:180d';
const GMAIL_QUERY_DAY  = 'subject:(application OR interview OR offer OR recruiter OR hiring) newer_than:1d';

function loadGmailToken() {
  try { return JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function saveGmailToken(token) {
  fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(token, null, 2), 'utf8');
}

async function getGmailAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw Object.assign(new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set'), { code: 'missing_client' });
  const token = loadGmailToken();
  if (!token?.refresh_token)
    throw Object.assign(new Error('Gmail not authorised — visit /api/tracker/auth'), { code: 'needs_auth' });
  if (!token.access_token || (token.expiry_date && token.expiry_date < Date.now() + 60_000)) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: token.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    });
    const fresh = await res.json();
    if (!res.ok) throw new Error(`Token refresh: ${fresh.error_description || fresh.error}`);
    token.access_token = fresh.access_token;
    token.expiry_date  = Date.now() + (fresh.expires_in || 3600) * 1000;
    saveGmailToken(token);
  }
  return token.access_token;
}

async function gmailApiFetch(path, accessToken) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}

module.exports = {
  GMAIL_REDIRECT, GMAIL_QUERY_FULL, GMAIL_QUERY_DAY,
  loadGmailToken, saveGmailToken, getGmailAccessToken, gmailApiFetch,
};
