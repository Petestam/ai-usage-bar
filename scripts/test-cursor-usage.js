#!/usr/bin/env node
/**
 * Live test: GET https://cursor.com/api/usage-summary with a cookie (no Electron).
 *
 *   CURSOR_TEST_COOKIE='paste full cookie here' npm run test:cursor
 *
 * The value MUST be in single quotes — cookie strings contain `;` and zsh/bash
 * will otherwise split them into separate commands (command not found: ...).
 *
 * Do not commit real cookies. Revoke session if this string leaks.
 */

const axios = require('axios');
const { buildCursorCookieHeader } = require('../providers/cookie-sanitize');
const { parseUsageSummary } = require('../providers/cursor-parse');

const cookie = (process.env.CURSOR_TEST_COOKIE || process.argv[2] || '').trim();
if (!cookie) {
  console.error('Usage: CURSOR_TEST_COOKIE=\'full cookie\' npm run test:cursor');
  console.error('        (single quotes required — cookie contains ; semicolons)');
  console.error('   or: node scripts/test-cursor-usage.js "<full cookie string>"');
  process.exit(1);
}

const headers = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://cursor.com',
  Referer: 'https://cursor.com/dashboard',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Cookie: buildCursorCookieHeader(cookie),
};

(async () => {
  try {
    const r = await axios.get('https://cursor.com/api/usage-summary', {
      headers,
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log('HTTP', r.status, r.statusText);
    const body = r.data;
    if (typeof body === 'object' && body !== null) {
      console.log('Top-level keys:', Object.keys(body));
      if (body.individualUsage && typeof body.individualUsage === 'object') {
        console.log('\nindividualUsage keys:', Object.keys(body.individualUsage));
        console.log(JSON.stringify(body.individualUsage, null, 2));
      }
    }
    if (r.status !== 200) {
      console.log('\nNon-200: session may be expired. Copy a fresh cookie from cursor.com (logged in) → Network → cookie header.');
      process.exit(body?.error ? 2 : 1);
    }
    const parsed = parseUsageSummary(body);
    if (!parsed) {
      console.log('\nparseUsageSummary returned null (error-shaped body or unknown JSON). Raw snippet:');
      console.log(JSON.stringify(body).slice(0, 600));
      process.exit(3);
    }
    console.log('\nParsed (what the menubar app uses):');
    console.log(JSON.stringify(parsed, (_, v) => (v instanceof Date ? v.toISOString() : v), 2));
    if (parsed?.onDemand) {
      console.log('\nOn-demand (spendLimitUsage):', parsed.onDemand);
    }
  } catch (e) {
    console.error(e.message);
    if (e.response) console.error('HTTP', e.response.status, e.response.data?.toString?.().slice(0, 300));
    process.exit(1);
  }
})();
