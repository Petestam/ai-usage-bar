// Cursor — undocumented cursor.com session APIs. Uses cookie (WorkosCursorSessionToken / next-auth) like the web dashboard.
// GET https://cursor.com/api/usage-summary

const axios = require('axios');
const debug = require('../debug');
const { canUseElectronNet, netGet } = require('./claude-net');
const { buildCursorCookieHeader } = require('./cookie-sanitize');
const { parseUsageSummary } = require('./cursor-parse');

const BROWSER_HEADERS = {
  Accept:            'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin:            'https://cursor.com',
  Referer:           'https://cursor.com/dashboard',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function cursorHeaders(storedCookie) {
  return {
    ...BROWSER_HEADERS,
    Cookie: buildCursorCookieHeader(storedCookie),
  };
}

let loggedTransport;
async function cursorGet(url, storedCookie, timeoutMs) {
  const headers = cursorHeaders(storedCookie);
  if (canUseElectronNet()) {
    if (!loggedTransport) {
      debug.logSettings('Cursor HTTP: using Electron net (Chromium TLS)');
      loggedTransport = true;
    }
    return netGet(url, headers, timeoutMs);
  }
  if (!loggedTransport) {
    debug.logSettings('Cursor HTTP: axios fallback');
    loggedTransport = true;
  }
  const r = await axios.get(url, { headers, timeout: timeoutMs });
  return { data: r.data, status: r.status, statusText: r.statusText };
}

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
  debug.logSettings('Cursor error response preview:', raw.slice(0, 500));
}

let loggedUsageSummaryKeys;

class CursorProvider {
  constructor(store) {
    this.store       = store;
    this.lastData    = null;
    this.lastFetched = null;
    this.changeRate  = 0;
  }

  async fetch() {
    const cookie = this.store.get('cursor_cookie');
    if (!cookie) return null;

    try {
      const resp = await cursorGet('https://cursor.com/api/usage-summary', cookie, 15000);
      const d    = resp.data;
      const parsed = parseUsageSummary(d);
      if (!parsed) {
        debug.logSettings('Cursor: unexpected usage-summary shape', Object.keys(d || {}));
        throw new Error('Unexpected usage response');
      }

      if (!loggedUsageSummaryKeys && parsed.utilization === 0) {
        loggedUsageSummaryKeys = true;
        debug.logSettings(
          'Cursor: usage-summary top-level keys (0% parsed — if usage should be non-zero, shape may differ):',
          Object.keys(d || {})
        );
      }

      const now = Date.now();
      if (this.lastData && this.lastFetched) {
        const mins  = (now - this.lastFetched) / 60000;
        const delta = parsed.utilization - (this.lastData.utilization || 0);
        this.changeRate = mins > 0 ? delta / mins : 0;
      }

      this.lastData    = { utilization: parsed.utilization };
      this.lastFetched = now;

      return {
        service:          'cursor',
        label:            'Cursor',
        utilization:      parsed.utilization,
        autoUtilization:  parsed.autoUtilization,
        apiUtilization:   parsed.apiUtilization,
        resetsAt:         parsed.resetsAt,
        displayMessage:   parsed.displayMessage || null,
        changeRate:       this.changeRate,
        lastFetched:      now,
        error:            null,
        errorDetail:      null,
      };
    } catch (e) {
      const status = e.response?.status;
      logErrorResponsePreview(e);
      const base = formatFetchError(e);
      debug.logSettings('Cursor fetch failed:', base);
      return {
        service:      'cursor',
        label:        'Cursor',
        error:        (status === 401 || status === 403) ? 'auth_expired' : (e.message || 'fetch_failed'),
        errorDetail:  base,
        lastFetched:  Date.now(),
        changeRate:   0,
      };
    }
  }
}

module.exports = CursorProvider;
