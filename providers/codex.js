// Codex / ChatGPT Work — session cookie → /api/auth/session → /backend-api/wham/usage
// Shares the agentic usage pool with Codex CLI, IDE extension, and ChatGPT Work.

const axios = require('axios');
const debug = require('../debug');
const { canUseElectronNet, netGet } = require('./claude-net');
const { buildChatGptCookieHeader } = require('./cookie-sanitize');
const { parseWhamUsage } = require('./codex-parse');

const BROWSER_HEADERS = {
  Accept:            'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin:            'https://chatgpt.com',
  Referer:           'https://chatgpt.com/codex',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function formatFetchError(e) {
  const status = e.response?.status;
  const st = e.response?.statusText;
  if (status) return `HTTP ${status}${st ? ` ${st}` : ''}`;
  const code = e.code;
  if (code) return `${code}: ${e.message || e}`;
  return e.message || String(e);
}

function logErrorResponsePreview(e) {
  const data = e.response?.data;
  if (data == null || data === '') return;
  let raw;
  if (typeof data === 'string') raw = data;
  else {
    try {
      raw = JSON.stringify(data);
    } catch {
      raw = String(data);
    }
  }
  debug.logSettings('Codex error response preview:', raw.slice(0, 500));
}

let loggedTransport;

async function chatgptGet(url, headers, timeoutMs) {
  if (canUseElectronNet()) {
    if (!loggedTransport) {
      debug.logSettings('Codex HTTP: using Electron net (Chromium TLS)');
      loggedTransport = true;
    }
    return netGet(url, headers, timeoutMs);
  }
  if (!loggedTransport) {
    debug.logSettings('Codex HTTP: axios fallback');
    loggedTransport = true;
  }
  const r = await axios.get(url, { headers, timeout: timeoutMs });
  return { data: r.data, status: r.status, statusText: r.statusText };
}

async function exchangeSessionToken(storedCookie) {
  const resp = await chatgptGet(
    'https://chatgpt.com/api/auth/session',
    { ...BROWSER_HEADERS, Cookie: buildChatGptCookieHeader(storedCookie) },
    15000
  );
  const token = resp.data?.accessToken;
  if (!token) throw new Error('No accessToken in session response');
  return token;
}

class CodexProvider {
  constructor(store) {
    this.store       = store;
    this.lastData    = null;
    this.lastFetched = null;
    this.changeRate  = 0;
  }

  async fetch() {
    const cookie = this.store.get('codex_cookie');
    if (!cookie) return null;

    try {
      const accessToken = await exchangeSessionToken(cookie);
      const resp = await chatgptGet(
        'https://chatgpt.com/backend-api/wham/usage',
        { ...BROWSER_HEADERS, Authorization: `Bearer ${accessToken}` },
        15000
      );

      const parsed = parseWhamUsage(resp.data);
      if (!parsed) {
        debug.logSettings('Codex: unexpected wham/usage shape', Object.keys(resp.data || {}));
        throw new Error('Unexpected usage response');
      }

      const now = Date.now();
      if (this.lastData && this.lastFetched) {
        const mins = (now - this.lastFetched) / 60000;
        const delta = (parsed.fiveHour?.utilization ?? 0) - (this.lastData.fiveHourUtil ?? 0);
        this.changeRate = mins > 0 ? delta / mins : 0;
      }

      this.lastData = { fiveHourUtil: parsed.fiveHour?.utilization ?? 0 };
      this.lastFetched = now;

      return {
        service:          'codex',
        label:            'Codex',
        fiveHour:         parsed.fiveHour,
        sevenDay:         parsed.sevenDay,
        gaugeUtilization: parsed.gaugeUtilization,
        utilization:      parsed.utilization,
        planType:         parsed.planType,
        credits:          parsed.credits,
        displayMessage:   parsed.displayMessage,
        changeRate:       this.changeRate,
        lastFetched:      now,
        error:            null,
        errorDetail:      null,
      };
    } catch (e) {
      const status = e.response?.status;
      logErrorResponsePreview(e);
      const base = formatFetchError(e);
      debug.logSettings('Codex fetch failed:', base);
      return {
        service:      'codex',
        label:        'Codex',
        error:        status === 401 || status === 403 ? 'auth_expired' : e.message || 'fetch_failed',
        errorDetail:  base,
        lastFetched:  Date.now(),
        changeRate:   0,
      };
    }
  }
}

module.exports = CodexProvider;
