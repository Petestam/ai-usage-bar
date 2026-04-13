// Claude provider — authenticates via the claude.ai sessionKey cookie (or full Cookie header).
// Uses Electron net (Chromium TLS) when available; Node/axios often gets HTTP 403 from Cloudflare
// for the same URL that works in a real browser.

const axios = require('axios');
const debug = require('../debug');
const { canUseElectronNet, netGet } = require('./claude-net');
const { buildClaudeCookieHeader } = require('./cookie-sanitize');

// Match a real browser for the rare axios fallback.
const BROWSER_HEADERS = {
  Accept:            'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin:            'https://claude.ai',
  Referer:           'https://claude.ai/',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function claudeHeaders(storedCredential) {
  return {
    ...BROWSER_HEADERS,
    Cookie: buildClaudeCookieHeader(storedCredential),
  };
}

let loggedTransport;
async function claudeGet(url, storedCredential, timeoutMs) {
  const headers = claudeHeaders(storedCredential);
  if (canUseElectronNet()) {
    if (!loggedTransport) {
      debug.logSettings('Claude HTTP: using Electron net (Chromium TLS, same stack as the browser)');
      loggedTransport = true;
    }
    return netGet(url, headers, timeoutMs);
  }
  if (!loggedTransport) {
    debug.logSettings('Claude HTTP: using axios fallback (Electron app not ready yet)');
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

function redactCookiesInText(str) {
  return String(str).replace(/sessionKey=[^;\s]+/gi, 'sessionKey=(redacted)');
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
  const preview = redactCookiesInText(raw).slice(0, 500);
  debug.logSettings('Claude error response preview:', preview);
}

function detailWith403Hint(e, baseDetail) {
  if (e.response?.status !== 403) return baseDetail;
  const data = e.response?.data;
  const htmlish = typeof data === 'string' && /cloudflare|challenge|cf-ray|attention required/i.test(data);
  if (htmlish) {
    return `${baseDetail} — Cloudflare HTML response; ensure the app uses Electron network (not axios-only). Paste full cookie header if needed.`;
  }
  return `${baseDetail} — If this persists, paste the full Cookie header (all cookies), not only sessionKey`;
}

class ClaudeProvider {
  constructor(store) {
    this.store        = store;
    this.orgUuid      = store.get('claude_org_uuid') || null;
    this.lastData     = null;
    this.lastFetched  = null;
    this.changeRate   = 0;
  }

  async resolveOrgUuid(storedCredential) {
    // Prefer persisted org (Settings) so we can skip /api/account when the user set this UUID.
    if (!this.orgUuid) {
      const fromStore = this.store.get('claude_org_uuid');
      if (fromStore) this.orgUuid = fromStore;
    }
    if (this.orgUuid) return this.orgUuid;

    const acct = await claudeGet('https://claude.ai/api/account', storedCredential, 10000);

    const memberships = acct.data?.memberships || [];

    for (const m of memberships) {
      const uuid = m.organization?.uuid;
      if (!uuid) continue;
      try {
        const r = await claudeGet(
          `https://claude.ai/api/organizations/${uuid}/usage`,
          storedCredential,
          8000
        );
        const d = r.data;
        if ((d.five_hour?.utilization ?? 0) > 0 || (d.seven_day?.utilization ?? 0) > 0) {
          this.orgUuid = uuid;
          this.store.set('claude_org_uuid', uuid);
          return uuid;
        }
      } catch (e) {
        logErrorResponsePreview(e);
        debug.logSettings('Claude org probe failed', uuid, formatFetchError(e));
      }
    }

    const fallback = memberships[0]?.organization?.uuid;
    if (fallback) {
      this.orgUuid = fallback;
      this.store.set('claude_org_uuid', fallback);
    }
    return fallback || null;
  }

  async fetch() {
    const storedCredential = this.store.get('claude_session_key');
    if (!storedCredential) return null;

    try {
      const uuid = await this.resolveOrgUuid(storedCredential);
      if (!uuid) throw new Error('Could not resolve org UUID');

      const resp = await claudeGet(
        `https://claude.ai/api/organizations/${uuid}/usage`,
        storedCredential,
        10000
      );

      const d   = resp.data;
      const now = Date.now();

      if (this.lastData && this.lastFetched) {
        const mins  = (now - this.lastFetched) / 60000;
        const delta = (d.five_hour?.utilization || 0) - (this.lastData.fiveHour?.utilization || 0);
        this.changeRate = mins > 0 ? delta / mins : 0;
      }

      this.lastData    = { fiveHour: d.five_hour, sevenDay: d.seven_day };
      this.lastFetched = now;

      return {
        service:    'claude',
        label:      'Claude',
        fiveHour: {
          utilization: d.five_hour?.utilization ?? 0,
          resetsAt:    d.five_hour?.resets_at ? new Date(d.five_hour.resets_at) : null,
        },
        sevenDay: {
          utilization: d.seven_day?.utilization ?? 0,
          resetsAt:    d.seven_day?.resets_at ? new Date(d.seven_day.resets_at) : null,
        },
        changeRate:   this.changeRate,
        lastFetched:  now,
        error:        null,
        errorDetail:  null,
      };
    } catch (e) {
      const status = e.response?.status;
      logErrorResponsePreview(e);
      const base = formatFetchError(e);
      const detail = status === 403 ? detailWith403Hint(e, base) : base;
      debug.logSettings('Claude fetch failed:', base);
      return {
        service:      'claude',
        label:        'Claude',
        error:        (status === 401 || status === 403) ? 'auth_expired' : (e.message || 'fetch_failed'),
        errorDetail:  detail,
        lastFetched:  Date.now(),
        changeRate:   0,
      };
    }
  }
}

module.exports = ClaudeProvider;
