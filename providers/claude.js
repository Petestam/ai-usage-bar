// Claude provider — authenticates via the claude.ai sessionKey cookie (or full Cookie header).
// Uses Electron net (Chromium TLS) when available; Node/axios often gets HTTP 403 from Cloudflare
// for the same URL that works in a real browser.

const axios = require('axios');
const debug = require('../debug');
const { canUseElectronNet, netGet } = require('./claude-net');
const { buildClaudeCookieHeader } = require('./cookie-sanitize');
const { fetchOrganizationCostMtdCached } = require('./anthropic-admin-cost');

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
    const adminKey = this.store.get('anthropic_admin_api_key');
    if (!storedCredential && !adminKey) return null;

    const spendLimitRaw = this.store.get('anthropic_api_spend_limit_usd');
    const parsedLimit =
      spendLimitRaw != null && String(spendLimitRaw).trim() !== ''
        ? parseFloat(String(spendLimitRaw))
        : NaN;
    const spendLimitUsd =
      Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 0;
    const now = Date.now();

    /** @type {{ fiveHour: object, sevenDay: object } | null} */
    let webPayload = null;
    let sessionError = null;
    let sessionErrorDetail = null;

    if (storedCredential) {
      try {
        const uuid = await this.resolveOrgUuid(storedCredential);
        if (!uuid) throw new Error('Could not resolve org UUID');

        const resp = await claudeGet(
          `https://claude.ai/api/organizations/${uuid}/usage`,
          storedCredential,
          10000
        );

        const d = resp.data;

        if (this.lastData && this.lastFetched) {
          const mins = (now - this.lastFetched) / 60000;
          const delta = (d.five_hour?.utilization || 0) - (this.lastData.fiveHour?.utilization || 0);
          this.changeRate = mins > 0 ? delta / mins : 0;
        }

        this.lastData = { fiveHour: d.five_hour, sevenDay: d.seven_day };
        this.lastFetched = now;

        webPayload = {
          fiveHour: {
            utilization: d.five_hour?.utilization ?? 0,
            resetsAt: d.five_hour?.resets_at ? new Date(d.five_hour.resets_at) : null,
          },
          sevenDay: {
            utilization: d.seven_day?.utilization ?? 0,
            resetsAt: d.seven_day?.resets_at ? new Date(d.seven_day.resets_at) : null,
          },
        };
      } catch (e) {
        const status = e.response?.status;
        logErrorResponsePreview(e);
        const base = formatFetchError(e);
        const detail = status === 403 ? detailWith403Hint(e, base) : base;
        debug.logSettings('Claude web usage fetch failed:', base);
        sessionError = status === 401 || status === 403 ? 'auth_expired' : e.message || 'fetch_failed';
        sessionErrorDetail = detail;
        this.changeRate = 0;
      }
    } else {
      this.changeRate = 0;
    }

    /** @type {null | { spendMtdUsd: number | null, spendLimitUsd: number | null, utilization: number, error: string | null }} */
    let consoleApi = null;
    if (adminKey) {
      const cost = await fetchOrganizationCostMtdCached(adminKey);
      if (cost.error) {
        debug.logSettings('Anthropic Console cost_report failed:', cost.error);
        consoleApi = {
          spendMtdUsd: null,
          spendLimitUsd: spendLimitUsd > 0 ? spendLimitUsd : null,
          utilization: 0,
          error: cost.error,
        };
      } else {
        const util =
          spendLimitUsd > 0
            ? Math.min(100, Math.round((cost.spendMtdUsd / spendLimitUsd) * 100))
            : 0;
        consoleApi = {
          spendMtdUsd: cost.spendMtdUsd,
          spendLimitUsd: spendLimitUsd > 0 ? spendLimitUsd : null,
          utilization: util,
          error: null,
        };
      }
      this.lastFetched = now;
    }

    const webUtil = webPayload?.fiveHour?.utilization ?? 0;
    const consoleUtil =
      consoleApi && !consoleApi.error && spendLimitUsd > 0 ? consoleApi.utilization : 0;
    const gaugeUtilization = Math.max(webUtil, consoleUtil);

    const hasWeb = webPayload != null;
    const hasConsole =
      consoleApi && !consoleApi.error && typeof consoleApi.spendMtdUsd === 'number';

    if (!hasWeb && !hasConsole) {
      const detail = sessionErrorDetail || (consoleApi?.error ? String(consoleApi.error) : null);
      const topErr =
        sessionError ||
        (consoleApi?.error === 'auth_expired' ? 'auth_expired' : null) ||
        'fetch_failed';
      return {
        service: 'claude',
        label: 'Claude',
        fiveHour: null,
        sevenDay: null,
        consoleApi,
        gaugeUtilization: 0,
        sessionError,
        sessionErrorDetail: sessionErrorDetail,
        changeRate: this.changeRate,
        lastFetched: now,
        error: topErr,
        errorDetail: detail,
      };
    }

    return {
      service: 'claude',
      label: 'Claude',
      fiveHour: webPayload?.fiveHour ?? null,
      sevenDay: webPayload?.sevenDay ?? null,
      consoleApi,
      gaugeUtilization,
      sessionError: hasWeb ? null : sessionError,
      sessionErrorDetail: hasWeb ? null : sessionErrorDetail,
      changeRate: this.changeRate,
      lastFetched: this.lastFetched || now,
      error: null,
      errorDetail: null,
    };
  }
}

module.exports = ClaudeProvider;
