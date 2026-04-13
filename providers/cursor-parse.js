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

  const onDemand = parseOnDemandSpend(data);

  return {
    utilization: util,
    autoUtilization: autoUtil != null ? Math.max(0, Math.min(100, autoUtil)) : null,
    apiUtilization: apiUtil != null ? Math.max(0, Math.min(100, apiUtil)) : null,
    resetsAt: resetsAtOut,
    displayMessage: subLabel,
    onDemand,
  };
}

function getNestedOnDemand(container) {
  if (!container || typeof container !== 'object') return null;
  const o = container.onDemand || container.on_demand;
  return o && typeof o === 'object' ? o : null;
}

/**
 * On-demand spend from GET /api/usage-summary.
 *
 * Primary shape (cursor.com web): `individualUsage.onDemand` / `teamUsage.onDemand` with
 * `used`, `limit`, `remaining` in **cents** — see community extensions’ typings.
 * Fallback: nested `spendLimitUsage` (Connect-RPC style totals).
 */
function parseOnDemandSpend(data) {
  if (!data || typeof data !== 'object') return null;

  const ind = data.individualUsage && typeof data.individualUsage === 'object' ? data.individualUsage : {};
  const team = data.teamUsage && typeof data.teamUsage === 'object' ? data.teamUsage : {};
  const limitTypeTop = String(data.limitType || '').toLowerCase();

  const indOd = getNestedOnDemand(ind);
  const teamOd = getNestedOnDemand(team);

  let od = null;
  let teamScope = false;
  if (limitTypeTop === 'team' && teamOd) {
    od = teamOd;
    teamScope = true;
  } else if (indOd) {
    od = indOd;
  } else if (teamOd) {
    od = teamOd;
    teamScope = true;
  }

  if (od) {
    let usedCents = asFiniteNumber(od.used);
    let limitCents = asFiniteNumber(od.limit);
    if (usedCents == null) usedCents = 0;
    if (limitCents == null) limitCents = 0;

    const odUnlimited =
      od.unlimited === true ||
      od.isUnlimited === true ||
      (limitCents === 0 && usedCents > 0);

    const show =
      od.enabled !== false &&
      (odUnlimited || limitCents > 0 || usedCents > 0);

    if (!show) {
      return null;
    }

    return {
      usedCents,
      limitCents,
      unlimited: !!odUnlimited,
      team: teamScope,
    };
  }

  const sl =
    (data.spendLimitUsage && typeof data.spendLimitUsage === 'object' && data.spendLimitUsage) ||
    (ind.spendLimitUsage && typeof ind.spendLimitUsage === 'object' && ind.spendLimitUsage) ||
    (ind.spend_limit_usage && typeof ind.spend_limit_usage === 'object' && ind.spend_limit_usage) ||
    (team.spendLimitUsage && typeof team.spendLimitUsage === 'object' && team.spendLimitUsage) ||
    null;

  if (!sl || typeof sl !== 'object') return null;

  const limitType = String(sl.limitType || sl.limit_type || data.limitType || '').toLowerCase();
  const useTeamPool =
    limitType === 'team' ||
    (asFiniteNumber(sl.pooledLimit ?? sl.pooled_limit) ?? 0) > 0;

  let usedCents = asFiniteNumber(sl.totalSpend ?? sl.total_spend);
  if (usedCents == null) {
    usedCents = asFiniteNumber(
      useTeamPool ? sl.pooledUsed ?? sl.pooled_used : sl.individualUsed ?? sl.individual_used
    );
  }
  let limitCents = asFiniteNumber(
    useTeamPool ? sl.pooledLimit ?? sl.pooled_limit : sl.individualLimit ?? sl.individual_limit
  );

  const unlimited =
    sl.isUnlimited === true ||
    sl.is_unlimited === true ||
    sl.unlimited === true;

  if (usedCents == null) usedCents = 0;
  if (limitCents == null) limitCents = 0;

  const show =
    unlimited ||
    limitCents > 0 ||
    usedCents > 0 ||
    (asFiniteNumber(sl.totalSpend ?? sl.total_spend) ?? 0) > 0;

  if (!show) {
    return null;
  }

  return {
    usedCents,
    limitCents,
    unlimited: !!unlimited,
    team: useTeamPool,
  };
}

module.exports = {
  asFiniteNumber,
  parseBillingCycleEnd,
  parseUsageSummary,
  parseOnDemandSpend,
};
