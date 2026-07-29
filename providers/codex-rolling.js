/**
 * Reconstruct a rolling utilization bucket from poll snapshots.
 * Events are util%-point increments; API util is source of truth on reconcile.
 */

const MIN_DELTA = 0.5; // ignore sub-percent noise / rounding jitter
const MAX_EVENTS = 4000;

function sumAmounts(events) {
  let s = 0;
  for (const e of events) s += e.amount;
  return s;
}

class RollingUtilEstimator {
  /**
   * @param {{ windowSeconds: number, events?: { t: number, amount: number }[] }} opts
   */
  constructor({ windowSeconds, events = [] } = {}) {
    this.windowSeconds = Number(windowSeconds) > 0 ? Number(windowSeconds) : 0;
    this.events = Array.isArray(events) ? events.slice() : [];
    this.lastUtil = null;
  }

  prune(nowMs) {
    if (!this.windowSeconds) return;
    const cutoff = nowMs - this.windowSeconds * 1000;
    if (this.events.length && this.events[0].t > cutoff) return;
    this.events = this.events.filter((e) => e.t > cutoff);
  }

  /** Force event sum ≈ observed util (API wins). */
  reconcile(util, nowMs) {
    this.prune(nowMs);
    let total = sumAmounts(this.events);
    const target = Math.max(0, util);

    if (total > target + MIN_DELTA) {
      let excess = total - target;
      while (excess > MIN_DELTA && this.events.length) {
        const first = this.events[0];
        if (first.amount <= excess + 1e-9) {
          excess -= first.amount;
          this.events.shift();
        } else {
          first.amount -= excess;
          excess = 0;
        }
      }
      total = sumAmounts(this.events);
    }

    if (target > total + MIN_DELTA) {
      this.events.push({ t: nowMs, amount: target - total });
    }

    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
  }

  observe(util, nowMs = Date.now()) {
    const u = Math.max(0, Math.min(100, Number(util) || 0));
    this.prune(nowMs);

    if (this.lastUtil != null) {
      const delta = u - this.lastUtil;
      if (delta >= MIN_DELTA) {
        this.events.push({ t: nowMs, amount: delta });
      }
    } else if (u >= MIN_DELTA) {
      // Cold start: seed as one lump at "now" (conservative — ages out late).
      this.events.push({ t: nowMs, amount: u });
    }

    this.reconcile(u, nowMs);
    this.lastUtil = u;
  }

  projectedUtil(atMs) {
    if (!this.windowSeconds) return this.lastUtil ?? 0;
    const cutoff = atMs - this.windowSeconds * 1000;
    let s = 0;
    for (const e of this.events) {
      if (e.t > cutoff && e.t <= atMs) s += e.amount;
    }
    return s;
  }

  /**
   * Earliest time when projected util drops by at least `dropPoints` from now,
   * or below `targetUtil` if provided.
   * @returns {{ at: number, fromUtil: number, toUtil: number } | null}
   */
  etaDrop({ dropPoints = 1, targetUtil = null, nowMs = Date.now() } = {}) {
    if (!this.windowSeconds || !this.events.length) return null;

    const fromUtil = this.projectedUtil(nowMs);
    const goal =
      targetUtil != null ? targetUtil : Math.max(0, fromUtil - dropPoints);
    if (fromUtil <= goal + 1e-9) return null;

    // Next drop happens when the oldest in-window event ages out.
    const sorted = this.events.slice().sort((a, b) => a.t - b.t);
    let running = fromUtil;
    for (const e of sorted) {
      const exitsAt = e.t + this.windowSeconds * 1000;
      if (exitsAt <= nowMs) continue;
      running -= e.amount;
      if (running <= goal + 1e-9) {
        return { at: exitsAt, fromUtil, toUtil: Math.max(0, running) };
      }
    }
    return null;
  }

  /** Serialize for electron-store. */
  toJSON() {
    return {
      windowSeconds: this.windowSeconds,
      events: this.events,
      lastUtil: this.lastUtil,
    };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') return null;
    const est = new RollingUtilEstimator({
      windowSeconds: data.windowSeconds,
      events: data.events,
    });
    est.lastUtil = data.lastUtil ?? null;
    return est;
  }
}

module.exports = { RollingUtilEstimator, MIN_DELTA };
