// OpenAI provider — uses an API key.
// Tracks spend (USD) against a monthly limit you set in settings.
// OpenAI's /v1/usage endpoint returns token counts per day.
// The billing endpoints (/dashboard/billing/*) return spend data.

const axios = require('axios');

class OpenAIProvider {
  constructor(store) {
    this.store       = store;
    this.lastData    = null;
    this.lastFetched = null;
    this.changeRate  = 0; // USD per minute
  }

  async fetch() {
    const apiKey = this.store.get('openai_api_key');
    if (!apiKey) return null;

    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const today   = new Date().toISOString().split('T')[0];
    const monthStart = new Date(); monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().split('T')[0];

    try {
      // Run token usage and billing in parallel; billing may 403 on restricted keys.
      const [tokenRes, billingSubRes, billingUsageRes] = await Promise.allSettled([
        axios.get(`https://api.openai.com/v1/usage?date=${today}`, { headers, timeout: 10000 }),
        axios.get('https://api.openai.com/dashboard/billing/subscription', { headers, timeout: 10000 }),
        axios.get(
          `https://api.openai.com/dashboard/billing/usage?start_date=${monthStartStr}&end_date=${today}`,
          { headers, timeout: 10000 }
        ),
      ]);

      // Tokens used today
      let tokensToday = 0;
      if (tokenRes.status === 'fulfilled') {
        tokensToday = (tokenRes.value.data?.data || []).reduce(
          (sum, item) =>
            sum + (item.n_context_tokens_total || 0) + (item.n_generated_tokens_total || 0),
          0
        );
      }

      // Spend limit: billing subscription > manual config fallback
      let spendLimit = this.store.get('openai_manual_limit', 20);
      if (billingSubRes.status === 'fulfilled') {
        spendLimit = billingSubRes.value.data?.hard_limit_usd ?? spendLimit;
      }

      // Month-to-date spend in USD (billing returns cents)
      let spendMtd = 0;
      if (billingUsageRes.status === 'fulfilled') {
        spendMtd = (billingUsageRes.value.data?.total_usage || 0) / 100;
      }

      const now         = Date.now();
      const utilization = spendLimit > 0 ? Math.round((spendMtd / spendLimit) * 100) : 0;

      // Burn rate: USD per minute
      if (this.lastData && this.lastFetched) {
        const mins  = (now - this.lastFetched) / 60000;
        const delta = spendMtd - (this.lastData.spendMtd || 0);
        this.changeRate = mins > 0 ? delta / mins : 0;
      }

      this.lastData    = { spendMtd };
      this.lastFetched = now;

      // Billing period resets on the 1st of next month
      const resetsAt = new Date(); resetsAt.setMonth(resetsAt.getMonth() + 1, 1); resetsAt.setHours(0, 0, 0, 0);

      return {
        service:      'openai',
        label:        'OpenAI',
        spendMtd,
        spendLimit,
        tokensToday,
        utilization,
        resetsAt,
        changeRate:   this.changeRate,
        lastFetched:  now,
        error:        null,
      };
    } catch (e) {
      const status = e.response?.status;
      return {
        service:     'openai',
        label:       'OpenAI',
        error:       (status === 401 || status === 403) ? 'auth_expired' : (e.message || 'fetch_failed'),
        lastFetched: Date.now(),
        changeRate:  0,
      };
    }
  }
}

module.exports = OpenAIProvider;
