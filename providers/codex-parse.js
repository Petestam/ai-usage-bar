/** Parse GET /backend-api/wham/usage (Codex + ChatGPT Work agentic quota). */

function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const utilization = Math.round(Math.max(0, Math.min(100, Number(w.used_percent) || 0)));
  let resetsAt = null;
  const resetAt = Number(w.reset_at);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    resetsAt = new Date(resetAt * 1000);
  } else {
    const after = Number(w.reset_after_seconds);
    if (Number.isFinite(after) && after >= 0) {
      resetsAt = new Date(Date.now() + after * 1000);
    }
  }
  return { utilization, resetsAt };
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

function parseWhamUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const rl = data.rate_limit;
  if (!rl || typeof rl !== 'object') return null;

  const fiveHour = parseWindow(rl.primary_window);
  const sevenDay = parseWindow(rl.secondary_window);
  if (!fiveHour && !sevenDay) return null;

  const fhUtil = fiveHour?.utilization ?? 0;
  const sdUtil = sevenDay?.utilization ?? 0;

  return {
    fiveHour,
    sevenDay,
    gaugeUtilization: Math.max(fhUtil, sdUtil),
    utilization: fhUtil,
    planType: typeof data.plan_type === 'string' ? data.plan_type : null,
    limitReached: !!rl.limit_reached,
    credits: parseCredits(data.credits),
    displayMessage: rl.limit_reached ? 'Limit reached' : null,
  };
}

module.exports = { parseWhamUsage, parseWindow };
