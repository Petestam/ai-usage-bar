#!/usr/bin/env node
/**
 * Live test: ChatGPT session cookie → /api/auth/session → /backend-api/wham/usage
 *
 *   CODEX_TEST_COOKIE='paste full cookie here' npm run test:codex
 *
 * Wrap the cookie in single quotes — it contains `;` semicolons.
 */

const axios = require('axios');
const { buildChatGptCookieHeader } = require('../providers/cookie-sanitize');
const { parseWhamUsage } = require('../providers/codex-parse');

const cookie = (process.env.CODEX_TEST_COOKIE || process.argv[2] || '').trim();
if (!cookie) {
  console.error("Usage: CODEX_TEST_COOKIE='full cookie' npm run test:codex");
  console.error('        (single quotes required — cookie contains ; semicolons)');
  process.exit(1);
}

const browserHeaders = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://chatgpt.com',
  Referer: 'https://chatgpt.com/codex',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

(async () => {
  try {
    const session = await axios.get('https://chatgpt.com/api/auth/session', {
      headers: { ...browserHeaders, Cookie: buildChatGptCookieHeader(cookie) },
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log('Session HTTP', session.status, session.statusText);
    const token = session.data?.accessToken;
    if (!token) {
      console.log('No accessToken — session may be expired. Log in at chatgpt.com and copy a fresh cookie.');
      process.exit(2);
    }
    console.log('accessToken: ok (length', token.length, ')');

    const usage = await axios.get('https://chatgpt.com/backend-api/wham/usage', {
      headers: { ...browserHeaders, Authorization: `Bearer ${token}` },
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log('Usage HTTP', usage.status, usage.statusText);
    if (usage.status !== 200) {
      console.log(JSON.stringify(usage.data).slice(0, 400));
      process.exit(usage.status === 401 || usage.status === 403 ? 2 : 1);
    }
    if (typeof usage.data === 'object' && usage.data !== null) {
      console.log('Top-level keys:', Object.keys(usage.data));
      if (usage.data.rate_limit) {
        console.log('rate_limit keys:', Object.keys(usage.data.rate_limit));
      }
    }
    const parsed = parseWhamUsage(usage.data);
    if (!parsed) {
      console.log('\nparseWhamUsage returned null. Raw snippet:');
      console.log(JSON.stringify(usage.data).slice(0, 600));
      process.exit(3);
    }
    console.log('\nParsed (what the menubar app uses):');
    console.log(JSON.stringify(parsed, (_, v) => (v instanceof Date ? v.toISOString() : v), 2));
  } catch (e) {
    console.error(e.message);
    if (e.response) console.error('HTTP', e.response.status, e.response.data?.toString?.().slice(0, 300));
    process.exit(1);
  }
})();
