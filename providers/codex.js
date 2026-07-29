// Codex / ChatGPT Work — session cookie → /api/auth/session → /backend-api/wham/usage
// Shares the agentic usage pool with Codex CLI, IDE extension, and ChatGPT Work.

const axios = require('axios');
const debug = require('../debug');
const { canUseElectronNet, netGet } = require('./claude-net');
const { buildChatGptCookieHeader } = require('./cookie-sanitize');
const { parseWhamUsage } = require('./codex-parse');
const { RollingUtilEstimator } = require('./codex-rolling');

const ROLLING_STORE_KEY = 'codex_rolling_estimators';

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

function chatgptAccountId(accessToken) {
  try {
    const part = accessToken.split('.')[1];
    if (!part) return null;
    const pad = (4 - (part.length % 4)) % 4;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json['https://api.openai.com/auth']?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function usageHeaders(accessToken) {
  const headers = { ...BROWSER_HEADERS, Authorization: `Bearer ${accessToken}` };
  const accountId = chatgptAccountId(accessToken);
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  return headers;
}

function logWindowSummary(parsed, raw) {
  const row = (w) =>
    w
      ? {
          label: w.label,
          util: w.utilization,
          windowH: w.limitWindowSeconds == null ? null : +(w.limitWindowSeconds / 3600).toFixed(2),
          resetH: w.resetAfterSeconds == null ? null : +(w.resetAfterSeconds / 3600).toFixed(2),
        }
      : null;
  const rl = raw?.rate_limit;
  debug.logSettings('Codex usage windows:', {
    plan: parsed.planType,
    primary: row(parsed.fiveHour),
    secondary: row(parsed.sevenDay),
    all: (parsed.windows || []).map(row),
    rawPrimary: rl?.primary_window
      ? {
          used: rl.primary_window.used_percent,
          limit_s: rl.primary_window.limit_window_seconds,
          after_s: rl.primary_window.reset_after_seconds,
          reset_at: rl.primary_window.reset_at,
        }
      : null,
    rawSecondary: rl?.secondary_window
      ? {
          used: rl.secondary_window.used_percent,
          limit_s: rl.secondary_window.limit_window_seconds,
          after_s: rl.secondary_window.reset_after_seconds,
          reset_at: rl.secondary_window.reset_at,
        }
      : null,
    additional: Array.isArray(raw?.additional_rate_limits)
      ? raw.additional_rate_limits.map((x) => ({
          name: x.limit_name || x.metered_feature,
          primary: x.rate_limit?.primary_window
            ? {
                used: x.rate_limit.primary_window.used_percent,
                limit_s: x.rate_limit.primary_window.limit_window_seconds,
                after_s: x.rate_limit.primary_window.reset_after_seconds,
              }
            : null,
        }))
      : [],
  });
}

class CodexProvider {
  constructor(store) {
    this.store       = store;
    this.lastData    = null;
    this.lastFetched = null;
    this.changeRate  = 0;
    /** @type {Map<string, import('./codex-rolling').RollingUtilEstimator>} */
    this.estimators  = new Map();
    this._loadEstimators();
  }

  _loadEstimators() {
    const raw = this.store.get(ROLLING_STORE_KEY);
    if (!raw || typeof raw !== 'object') return;
    for (const [key, data] of Object.entries(raw)) {
      const est = RollingUtilEstimator.fromJSON(data);
      if (est) this.estimators.set(key, est);
    }
  }

  _saveEstimators() {
    const out = {};
    for (const [key, est] of this.estimators) out[key] = est.toJSON();
    this.store.set(ROLLING_STORE_KEY, out);
  }

  _estimatorKey(w) {
    return `${w.label || 'window'}:${w.limitWindowSeconds || 0}`;
  }

  /** Observe util + attach estimatedRecoveryMs when we can project a drop. */
  _applyRolling(windows, nowMs) {
    if (!Array.isArray(windows)) return;
    let dirty = false;
    for (const w of windows) {
      if (!w || !w.limitWindowSeconds || w.limitWindowSeconds < 3600) continue;
      const key = this._estimatorKey(w);
      let est = this.estimators.get(key);
      if (!est || est.windowSeconds !== w.limitWindowSeconds) {
        est = new RollingUtilEstimator({ windowSeconds: w.limitWindowSeconds });
        this.estimators.set(key, est);
      }
      est.observe(w.utilization ?? 0, nowMs);
      dirty = true;

      const eta = est.etaDrop({ dropPoints: 1, nowMs });
      if (eta && eta.at > nowMs) {
        w.estimatedRecoveryMs = eta.at;
        w.estimatedFromUtil = Math.round(eta.fromUtil);
        w.estimatedToUtil = Math.round(Math.max(0, eta.toUtil));
        w.rollingSampleCount = est.events.length;
      } else {
        w.estimatedRecoveryMs = null;
        w.rollingSampleCount = est.events.length;
      }
    }
    if (dirty) this._saveEstimators();
  }

  async fetch() {
    const cookie = this.store.get('codex_cookie');
    if (!cookie) return null;

    try {
      const accessToken = await exchangeSessionToken(cookie);
      const resp = await chatgptGet(
        'https://chatgpt.com/backend-api/wham/usage',
        usageHeaders(accessToken),
        15000
      );

      const parsed = parseWhamUsage(resp.data);
      if (!parsed) {
        debug.logSettings('Codex: unexpected wham/usage shape', Object.keys(resp.data || {}));
        throw new Error('Unexpected usage response');
      }
      logWindowSummary(parsed, resp.data);

      const now = Date.now();
      if (this.lastData && this.lastFetched) {
        const mins = (now - this.lastFetched) / 60000;
        const delta = (parsed.fiveHour?.utilization ?? 0) - (this.lastData.fiveHourUtil ?? 0);
        this.changeRate = mins > 0 ? delta / mins : 0;
      }

      this.lastData = { fiveHourUtil: parsed.fiveHour?.utilization ?? 0 };
      this.lastFetched = now;

      const displayWindows = [];
      const seen = new Set();
      const add = (w) => {
        if (!w) return;
        const k = `${w.label}|${w.limitWindowSeconds}|${w.utilization}`;
        if (seen.has(k)) return;
        seen.add(k);
        displayWindows.push(w);
      };
      add(parsed.fiveHour);
      add(parsed.sevenDay);
      for (const w of parsed.windows || []) add(w);

      this._applyRolling(displayWindows, now);

      return {
        service:          'codex',
        label:            'Codex',
        fiveHour:         parsed.fiveHour,
        sevenDay:         parsed.sevenDay,
        windows:          displayWindows,
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
