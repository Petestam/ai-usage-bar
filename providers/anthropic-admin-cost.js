/**
 * Anthropic Console org API spend via Admin API (sk-ant-admin...).
 * GET https://api.anthropic.com/v1/organizations/cost_report
 * Docs: https://platform.claude.com/docs/en/build-with-claude/usage-cost-api
 *
 * Amount strings are in cents; total is summed and converted to USD.
 *
 * Note: Per Anthropic, Priority Tier costs are not included in cost_report; the
 * Console “Usage and spend limits” total can also differ (billing period, product mix).
 */

const axios = require('axios');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/organizations/cost_report';
const COST_TTL_MS = 10 * 60 * 1000;
const costCache = new Map();

function monthRangeUtcIso() {
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
  };
}

/**
 * @returns {{ spendMtdUsd: number, error: null } | { spendMtdUsd: null, error: string }}
 */
async function fetchOrganizationCostMtd(adminApiKey) {
  if (!adminApiKey || typeof adminApiKey !== 'string' || !adminApiKey.trim()) {
    return { spendMtdUsd: null, error: 'missing_admin_key' };
  }

  const { starting_at, ending_at } = monthRangeUtcIso();
  let totalCents = 0;
  let page = null;

  try {
    for (let guard = 0; guard < 50; guard++) {
      const params = {
        starting_at,
        ending_at,
        bucket_width: '1d',
      };
      if (page) params.page = page;

      const r = await axios.get(ANTHROPIC_API, {
        params,
        headers: {
          'x-api-key': adminApiKey.trim(),
          'anthropic-version': '2023-06-01',
          'User-Agent': 'AI-Usage-Bar (https://github.com/Petestam/ai-usage-bar)',
        },
        timeout: 25000,
        validateStatus: () => true,
      });

      if (r.status === 401 || r.status === 403) {
        return { spendMtdUsd: null, error: 'auth_expired' };
      }
      if (r.status < 200 || r.status >= 300) {
        const msg = r.data?.error?.message || r.data?.message || r.statusText || String(r.status);
        return { spendMtdUsd: null, error: `HTTP ${r.status}: ${msg}` };
      }

      const body = r.data || {};
      const buckets = Array.isArray(body.data) ? body.data : [];
      for (const bucket of buckets) {
        const results = Array.isArray(bucket.results) ? bucket.results : [];
        for (const row of results) {
          const raw = row.amount;
          if (raw == null) continue;
          const cents = parseFloat(String(raw));
          if (Number.isFinite(cents)) totalCents += cents;
        }
      }

      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    const spendMtdUsd = totalCents / 100;
    return { spendMtdUsd, error: null };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      return { spendMtdUsd: null, error: 'auth_expired' };
    }
    return { spendMtdUsd: null, error: e.message || String(e) };
  }
}

async function fetchOrganizationCostMtdCached(adminApiKey, ttlMs = COST_TTL_MS) {
  const key = (adminApiKey || '').trim();
  if (!key) return { spendMtdUsd: null, error: 'missing_admin_key' };
  const monthKey = new Date().toISOString().slice(0, 7);
  const cacheKey = `${monthKey}:${key}`;
  const cached = costCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;
  const value = await fetchOrganizationCostMtd(adminApiKey);
  costCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

module.exports = {
  fetchOrganizationCostMtd,
  fetchOrganizationCostMtdCached,
  monthRangeUtcIso,
};
