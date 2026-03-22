// Claude provider — authenticates via the claude.ai sessionKey cookie.
// Hits /api/organizations/{uuid}/usage which returns:
//   five_hour.utilization  (0–100, current session window)
//   five_hour.resets_at    (ISO timestamp)
//   seven_day.utilization  (0–100, weekly rollup)
//   seven_day.resets_at

const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':     'application/json',
};

class ClaudeProvider {
  constructor(store) {
    this.store        = store;
    this.orgUuid      = store.get('claude_org_uuid') || null;
    this.lastData     = null;
    this.lastFetched  = null;
    this.changeRate   = 0; // utilization points per minute (five_hour window)
  }

  // Find the org UUID whose /usage endpoint has non-zero data.
  // Caches result in store so we don't probe every cycle.
  async resolveOrgUuid(sessionKey) {
    if (this.orgUuid) return this.orgUuid;

    const acct = await axios.get('https://claude.ai/api/account', {
      headers: { ...HEADERS, Cookie: `sessionKey=${sessionKey}` },
      timeout: 10000,
    });

    const memberships = acct.data?.memberships || [];

    for (const m of memberships) {
      const uuid = m.organization?.uuid;
      if (!uuid) continue;
      try {
        const r = await axios.get(`https://claude.ai/api/organizations/${uuid}/usage`, {
          headers: { ...HEADERS, Cookie: `sessionKey=${sessionKey}` },
          timeout: 8000,
        });
        const d = r.data;
        if ((d.five_hour?.utilization ?? 0) > 0 || (d.seven_day?.utilization ?? 0) > 0) {
          this.orgUuid = uuid;
          this.store.set('claude_org_uuid', uuid);
          return uuid;
        }
      } catch { /* try next */ }
    }

    // None showed activity — use the first one (new account, fresh reset, etc.)
    const fallback = memberships[0]?.organization?.uuid;
    if (fallback) {
      this.orgUuid = fallback;
      this.store.set('claude_org_uuid', fallback);
    }
    return fallback || null;
  }

  async fetch() {
    const sessionKey = this.store.get('claude_session_key');
    if (!sessionKey) return null;

    try {
      const uuid = await this.resolveOrgUuid(sessionKey);
      if (!uuid) throw new Error('Could not resolve org UUID');

      const resp = await axios.get(`https://claude.ai/api/organizations/${uuid}/usage`, {
        headers: { ...HEADERS, Cookie: `sessionKey=${sessionKey}` },
        timeout: 10000,
      });

      const d   = resp.data;
      const now = Date.now();

      // Burn rate: how many utilization points per minute in the 5-hour window
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
        changeRate:  this.changeRate,
        lastFetched: now,
        error:       null,
      };
    } catch (e) {
      const status = e.response?.status;
      return {
        service:     'claude',
        label:       'Claude',
        error:       (status === 401 || status === 403) ? 'auth_expired' : (e.message || 'fetch_failed'),
        lastFetched: Date.now(),
        changeRate:  0,
      };
    }
  }
}

module.exports = ClaudeProvider;
