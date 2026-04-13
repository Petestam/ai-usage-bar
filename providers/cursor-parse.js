/**
 * Pure parsing for Cursor /api/usage-summary (no Electron). Used by cursor.js and test script.
 */

function asFiniteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Unix ms string, numeric ms/sec, or ISO 8601. */
function parseBillingCycleEnd(end) {
  if (end == null) return null;
  if (typeof end === 'number' && Number.isFinite(end)) {
    return new Date(end > 1e12 ? end : end * 1000);
  }
  if (typeof end === 'string') {
    const t = end.trim();
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      if (Number.isFinite(n)) return new Date(n > 1e12 ? n : n * 1000);
    }
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Normalize usage-summary JSON to 0–100 utilization + optional reset date. */
function parseUsageSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;

  // API sometimes returns { error, description } (e.g. stale session) with no usage fields.
  if (
    data.error != null &&
    !data.planUsage &&
    !data.plan_usage &&
    !data.individualUsage &&
    !data.teamUsage &&
    !(data.plan && typeof data.plan === 'object')
  ) {
    return null;
  }

  const plan = data.planUsage || data.plan_usage || data.plan || {};
  const ind =
    data.individualUsage && typeof data.individualUsage === 'object' ? data.individualUsage : {};
  const team = data.teamUsage && typeof data.teamUsage === 'object' ? data.teamUsage : {};
  // Dashboard often nests metrics under individualUsage.plan (same semantics as planUsage elsewhere).
  const indPlan = ind.plan && typeof ind.plan === 'object' ? ind.plan : {};
  const teamPlan = team.plan && typeof team.plan === 'object' ? team.plan : {};

  // Current cursor.com shape: individualUsage / teamUsage (not always top-level planUsage).
  let util = asFiniteNumber(
    indPlan.totalPercentUsed ??
      indPlan.total_percent_used ??
      ind.totalPercentUsed ??
      ind.total_percent_used ??
      ind.totalUsagePercent ??
      ind.totalUsage ??
      teamPlan.totalPercentUsed ??
      team.totalPercentUsed ??
      team.total_percent_used ??
      plan.totalPercentUsed ??
      plan.total_percent_used ??
      data.totalPercentUsed ??
      data.percentUsed ??
      data.utilization ??
      data.usagePercent ??
      plan.percentUsed
  );

  const autoUtil = asFiniteNumber(
    indPlan.autoPercentUsed ??
      indPlan.auto_percent_used ??
      ind.autoPercentUsed ??
      ind.auto_percent_used ??
      ind.autoUsagePercent
  );
  const apiUtil = asFiniteNumber(
    indPlan.apiPercentUsed ??
      indPlan.api_percent_used ??
      ind.apiPercentUsed ??
      ind.api_percent_used ??
      ind.apiUsagePercent
  );

  if (util == null) {
    const limit = asFiniteNumber(
      indPlan.limit ??
        ind.limit ??
        plan.limit ??
        data.limit ??
        plan.includedLimitCents ??
        plan.included_limit_cents
    );
    const used = asFiniteNumber(
      indPlan.used ??
        indPlan.includedSpend ??
        ind.used ??
        ind.includedSpend ??
        ind.totalSpend ??
        plan.includedSpend ??
        plan.totalSpend ??
        plan.included_spend ??
        data.includedSpend ??
        data.usedCents
    );
    if (limit != null && limit > 0 && used != null) {
      util = (used / limit) * 100;
    }
  }

  if (util == null || !Number.isFinite(util)) {
    util = 0;
  }

  util = Math.max(0, Math.min(100, util));

  const end =
    data.billingCycleEnd ??
    plan.billingCycleEnd ??
    data.billing_cycle_end ??
    data.cycleEnd ??
    data.resetAt;

  const resetsAtParsed = parseBillingCycleEnd(end);
  const resetsAtOut =
    resetsAtParsed && resetsAtParsed.getTime() > Date.now() ? resetsAtParsed : null;

  let subLabel =
    typeof data.displayMessage === 'string'
      ? data.displayMessage
      : typeof plan.displayMessage === 'string'
        ? plan.displayMessage
        : typeof data.message === 'string'
          ? data.message
          : '';
  if (!subLabel) {
    const bits = [data.autoModelSelectedDisplayMessage, data.namedModelSelectedDisplayMessage].filter(
      (x) => typeof x === 'string' && x.trim()
    );
    if (bits.length) subLabel = bits.join(' · ');
  }

  return {
    utilization: util,
    autoUtilization: autoUtil != null ? Math.max(0, Math.min(100, autoUtil)) : null,
    apiUtilization: apiUtil != null ? Math.max(0, Math.min(100, apiUtil)) : null,
    resetsAt: resetsAtOut,
    displayMessage: subLabel,
  };
}

module.exports = {
  asFiniteNumber,
  parseBillingCycleEnd,
  parseUsageSummary,
};
