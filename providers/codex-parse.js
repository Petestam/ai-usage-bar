/** Parse GET /backend-api/wham/usage (Codex + ChatGPT Work agentic quota). */

function windowLabel(limitWindowSeconds) {
  const s = Number(limitWindowSeconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s >= 86400) {
    const days = Math.round(s / 86400);
    return days === 7 ? 'Weekly' : `${days}-day`;
  }
  const hours = Math.max(1, Math.round(s / 3600));
  return hours === 1 ? '1-hour' : `${hours}-hour`;
}

/** True when reset_after ≈ full window length (rolling bucket, not a hard cliff). */
function isRollingFullWindow(limitWindowSeconds, resetAfterSeconds) {
  const lim = Number(limitWindowSeconds);
  const after = Number(resetAfterSeconds);
  if (!Number.isFinite(lim) || lim <= 0 || !Number.isFinite(after) || after < 0) return false;
  // Within ~1h of the full window duration → still essentially "full period remaining".
  return Math.abs(lim - after) < 3600 || after / lim > 0.95;
}

function resetMsFromFields(w, nowMs) {
  const afterSec = Number(w.reset_after_seconds);
  let fromAfter = null;
  if (Number.isFinite(afterSec) && afterSec >= 0) {
    fromAfter = nowMs + afterSec * 1000;
  }
  let fromAt = null;
  const raw = Number(w.reset_at);
  if (Number.isFinite(raw) && raw > 0) {
    fromAt = raw > 1_000_000_000_000 ? raw : raw * 1000;
  }
  // Prefer the live countdown; fall back to absolute timestamp.
  if (fromAfter != null) return fromAfter;
  return fromAt;
}

function parseResetTime(w, nowMs = Date.now()) {
  const ms = resetMsFromFields(w, nowMs);
  return ms == null ? null : new Date(ms);
}

function parseWindow(w, nowMs = Date.now(), labelOverride = null) {
  if (!w || typeof w !== 'object') return null;
  const utilization = Math.round(Math.max(0, Math.min(100, Number(w.used_percent) || 0)));
  const afterSec = Number(w.reset_after_seconds);
  const limitWindowSeconds = Number(w.limit_window_seconds);
  const label =
    labelOverride ||
    windowLabel(limitWindowSeconds) ||
    (Number.isFinite(limitWindowSeconds) ? `${limitWindowSeconds}s` : null);
  return {
    utilization,
    resetsAt: parseResetTime(w, nowMs),
    resetAfterSeconds:
      Number.isFinite(afterSec) && afterSec >= 0 ? afterSec : null,
    limitWindowSeconds: Number.isFinite(limitWindowSeconds) ? limitWindowSeconds : null,
    rolling: isRollingFullWindow(limitWindowSeconds, afterSec),
    label,
  };
}

function parseIndividualLimit(il, nowMs = Date.now()) {
  if (!il || typeof il !== 'object') return null;
  const used =
    il.used_percent != null
      ? Number(il.used_percent)
      : il.limit != null && il.used != null
        ? (Number(il.used) / Number(il.limit)) * 100
        : null;
  return parseWindow(
    {
      used_percent: used,
      reset_after_seconds: il.reset_after_seconds,
      reset_at: il.reset_at,
      limit_window_seconds: 30 * 86400,
    },
    nowMs,
    'Monthly credits'
  );
}

function addWindow(out, w, nowMs, labelOverride) {
  const parsed = parseWindow(w, nowMs, labelOverride);
  if (parsed) out.push(parsed);
}

function collectWindows(data, nowMs = Date.now()) {
  const windows = [];
  const rl = data.rate_limit;
  if (rl && typeof rl === 'object') {
    // Label from window length — team plans often put a weekly pool in primary.
    addWindow(windows, rl.primary_window, nowMs, null);
    addWindow(windows, rl.secondary_window, nowMs, null);
  }
  const review = data.code_review_rate_limit;
  if (review && typeof review === 'object') {
    addWindow(windows, review.primary_window, nowMs, 'Code review');
    addWindow(windows, review.secondary_window, nowMs, 'Code review weekly');
  }
  const extras = data.additional_rate_limits;
  if (Array.isArray(extras)) {
    for (const extra of extras) {
      if (!extra || typeof extra !== 'object') continue;
      const name = extra.limit_name || extra.metered_feature || 'Other';
      const erl = extra.rate_limit;
      if (!erl || typeof erl !== 'object') continue;
      const primaryLabel = windowLabel(erl.primary_window?.limit_window_seconds) || name;
      addWindow(windows, erl.primary_window, nowMs, primaryLabel);
      addWindow(windows, erl.secondary_window, nowMs, `${name} weekly`);
    }
  }
  const monthly = parseIndividualLimit(data.spend_control?.individual_limit, nowMs);
  if (monthly) windows.push(monthly);
  return windows;
}

function parseCredits(credits) {
  if (!credits || typeof credits !== 'object') return null;
  const hasCredits = !!credits.has_credits;
  const unlimited = !!credits.unlimited;
  const raw = credits.balance;
  const balance =
    raw === undefined || raw === null || raw === ''
      ? null
      : parseFloat(String(raw));
  if (!hasCredits && balance == null) return null;
  return {
    hasCredits,
    unlimited,
    balance: Number.isFinite(balance) ? balance : null,
  };
}

function parseWhamUsage(data, nowMs = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  const rl = data.rate_limit;
  if (!rl || typeof rl !== 'object') return null;

  const fiveHour = parseWindow(rl.primary_window, nowMs, null);
  const sevenDay = parseWindow(rl.secondary_window, nowMs, null);
  const windows = collectWindows(data, nowMs);
  if (!fiveHour && !sevenDay && windows.length === 0) return null;

  const fhUtil = fiveHour?.utilization ?? 0;
  const sdUtil = sevenDay?.utilization ?? 0;

  return {
    fiveHour,
    sevenDay,
    windows,
    gaugeUtilization: Math.max(
      fhUtil,
      sdUtil,
      ...windows.map((w) => w.utilization ?? 0),
      0
    ),
    utilization: fhUtil,
    planType: typeof data.plan_type === 'string' ? data.plan_type : null,
    limitReached: !!rl.limit_reached,
    credits: parseCredits(data.credits),
    displayMessage: rl.limit_reached ? 'Limit reached' : null,
  };
}

module.exports = {
  parseWhamUsage,
  parseWindow,
  parseResetTime,
  windowLabel,
  collectWindows,
  isRollingFullWindow,
};
