/**
 * Rolling util ledger: attribute poll deltas into time buckets and age them out.
 * We only get used_percent from the API (not tokens), so amounts are util %-points.
 */

const MIN_DELTA = 0.5;

/** Bucket width from window length: days for weeklies, hours for session windows. */
function bucketSecondsForWindow(windowSeconds) {
  const w = Number(windowSeconds) || 0;
  if (w >= 2 * 86400) return 86400; // daily
  if (w >= 2 * 3600) return 3600; // hourly
  return 900; // 15m
}

function bucketStart(ts, bucketSeconds) {
  const d = new Date(ts);
  if (bucketSeconds >= 86400) {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (bucketSeconds >= 3600) {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  return Math.floor(ts / (bucketSeconds * 1000)) * bucketSeconds * 1000;
}

/** Step back/forward N calendar buckets (DST-safe for daily). */
function shiftBucketStart(startMs, bucketSeconds, deltaSlots) {
  if (bucketSeconds >= 86400) {
    const d = new Date(startMs);
    d.setDate(d.getDate() + deltaSlots);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return startMs + deltaSlots * bucketSeconds * 1000;
}

function sumAmounts(buckets) {
  let s = 0;
  for (const b of buckets) s += b.amount;
  return s;
}

class RollingUtilEstimator {
  /**
   * @param {{ windowSeconds: number, buckets?: object[], lastUtil?: number|null }} opts
   */
  constructor({ windowSeconds, buckets = [], lastUtil = null } = {}) {
    this.windowSeconds = Number(windowSeconds) > 0 ? Number(windowSeconds) : 0;
    this.bucketSeconds = bucketSecondsForWindow(this.windowSeconds);
    this.buckets = Array.isArray(buckets) ? buckets.map((b) => ({ ...b })) : [];
    this.lastUtil = lastUtil;
  }

  prune(nowMs) {
    if (!this.windowSeconds) return;
    // Keep buckets whose usage hasn't fully aged out (born + window > now).
    this.buckets = this.buckets.filter((b) => {
      const born = b.firstAt ?? b.start;
      return born + this.windowSeconds * 1000 > nowMs;
    });
  }

  _addToBucket(amount, atMs) {
    if (amount < MIN_DELTA / 4) return;
    const start = bucketStart(atMs, this.bucketSeconds);
    let b = this.buckets.find((x) => x.start === start);
    if (!b) {
      b = { start, amount: 0, firstAt: atMs, lastAt: atMs };
      this.buckets.push(b);
      this.buckets.sort((a, c) => a.start - c.start);
    }
    b.amount += amount;
    b.firstAt = Math.min(b.firstAt ?? atMs, atMs);
    b.lastAt = Math.max(b.lastAt ?? atMs, atMs);
  }

  /** Trim oldest buckets until sum ≈ target (API is source of truth). */
  reconcile(util, nowMs) {
    this.prune(nowMs);
    let total = sumAmounts(this.buckets);
    const target = Math.max(0, util);

    if (total > target + MIN_DELTA) {
      let excess = total - target;
      this.buckets.sort((a, b) => a.start - b.start);
      while (excess > MIN_DELTA && this.buckets.length) {
        const first = this.buckets[0];
        if (first.amount <= excess + 1e-9) {
          excess -= first.amount;
          this.buckets.shift();
        } else {
          first.amount -= excess;
          excess = 0;
        }
      }
      total = sumAmounts(this.buckets);
    }

    if (target > total + MIN_DELTA) {
      this._addToBucket(target - total, nowMs);
    }
  }

  observe(util, nowMs = Date.now()) {
    const u = Math.max(0, Math.min(100, Number(util) || 0));
    this.prune(nowMs);

    if (this.lastUtil != null) {
      const delta = u - this.lastUtil;
      if (delta >= MIN_DELTA) this._addToBucket(delta, nowMs);
    } else if (u >= MIN_DELTA) {
      // Cold start: put unknown history in today's bucket (conservative age-out).
      this._addToBucket(u, nowMs);
    }

    this.reconcile(u, nowMs);
    this.lastUtil = u;
  }

  projectedUtil(atMs) {
    if (!this.windowSeconds) return this.lastUtil ?? 0;
    let s = 0;
    for (const b of this.buckets) {
      const born = b.firstAt ?? b.start;
      if (born <= atMs && born + this.windowSeconds * 1000 > atMs) s += b.amount;
    }
    return s;
  }

  /**
   * Next meaningful drop: when the oldest bucket starts aging out.
   * @returns {{ at: number, fromUtil: number, toUtil: number, dropAmount: number, bucketStart: number } | null}
   */
  etaDrop({ dropPoints = 1, nowMs = Date.now() } = {}) {
    if (!this.windowSeconds || !this.buckets.length) return null;
    this.prune(nowMs);

    const sorted = this.buckets.slice().sort((a, b) => a.start - b.start);
    const fromUtil = sumAmounts(sorted);
    const goal = Math.max(0, fromUtil - dropPoints);
    if (fromUtil <= goal + 1e-9) return null;

    let running = fromUtil;
    for (const b of sorted) {
      // Age-out using first seen time when available (closer to true rolling).
      const born = b.firstAt ?? b.start;
      const exitsAt = born + this.windowSeconds * 1000;
      if (exitsAt <= nowMs) continue;
      running -= b.amount;
      if (running <= goal + 1e-9 || b.amount >= dropPoints - 1e-9) {
        return {
          at: exitsAt,
          fromUtil,
          toUtil: Math.max(0, fromUtil - b.amount),
          dropAmount: b.amount,
          bucketStart: b.start,
        };
      }
    }
    return null;
  }

  /** Snapshot of buckets still in the window (for UI strip). */
  ledger(nowMs = Date.now()) {
    this.prune(nowMs);
    const slots = Math.max(1, Math.ceil(this.windowSeconds / this.bucketSeconds));
    const newestStart = bucketStart(nowMs, this.bucketSeconds);
    const out = [];
    for (let i = slots - 1; i >= 0; i--) {
      const start = shiftBucketStart(newestStart, this.bucketSeconds, -i);
      const b = this.buckets.find((x) => x.start === start);
      const amount = b?.amount ?? 0;
      const agesOutAt = (b?.firstAt ?? start) + this.windowSeconds * 1000;
      out.push({
        start,
        amount: Math.round(amount * 10) / 10,
        agesOutAt,
        label: this._slotLabel(start, nowMs),
      });
    }
    return out;
  }

  _slotLabel(start, nowMs) {
    if (this.bucketSeconds >= 86400) {
      const d = new Date(start);
      const today = bucketStart(nowMs, 86400);
      if (start === today) return 'today';
      if (start === shiftBucketStart(today, 86400, -1)) return 'yday';
      return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    if (this.bucketSeconds >= 3600) {
      return new Date(start).toLocaleTimeString(undefined, { hour: 'numeric' });
    }
    return new Date(start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  toJSON() {
    return {
      windowSeconds: this.windowSeconds,
      bucketSeconds: this.bucketSeconds,
      buckets: this.buckets,
      lastUtil: this.lastUtil,
    };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') return null;
    // Migrate v1 event list → one bucket per event timestamp.
    if (Array.isArray(data.events) && !data.buckets) {
      const est = new RollingUtilEstimator({ windowSeconds: data.windowSeconds });
      for (const e of data.events) {
        if (e && e.amount > 0 && e.t) est._addToBucket(e.amount, e.t);
      }
      est.lastUtil = data.lastUtil ?? null;
      return est;
    }
    const est = new RollingUtilEstimator({
      windowSeconds: data.windowSeconds,
      buckets: data.buckets,
      lastUtil: data.lastUtil ?? null,
    });
    if (data.bucketSeconds) est.bucketSeconds = data.bucketSeconds;
    return est;
  }
}

module.exports = {
  RollingUtilEstimator,
  bucketSecondsForWindow,
  bucketStart,
  shiftBucketStart,
  MIN_DELTA,
};
