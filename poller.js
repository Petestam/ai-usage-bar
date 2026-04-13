const ClaudeProvider  = require('./providers/claude');
const OpenAIProvider  = require('./providers/openai');
const CursorProvider  = require('./providers/cursor');

const ACTIVE_WINDOW_MS = 30 * 60 * 1000; // 30 min of no change = idle

class Poller {
  constructor(store, onUpdate) {
    this.store    = store;
    this.onUpdate = onUpdate;
    this.claude   = new ClaudeProvider(store);
    this.openai   = new OpenAIProvider(store);
    this.cursor   = new CursorProvider(store);
    this.state    = { claude: null, openai: null, cursor: null };
    this.timer    = null;
    this._pollInFlight = false;
  }

  async poll() {
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      const [c, o, u] = await Promise.allSettled([
        this.store.get('claude_session_key') ? this.claude.fetch() : Promise.resolve(null),
        this.store.get('openai_api_key')     ? this.openai.fetch() : Promise.resolve(null),
        this.store.get('cursor_cookie')      ? this.cursor.fetch() : Promise.resolve(null),
      ]);
      if (c.status === 'fulfilled' && c.value) this.state.claude = c.value;
      if (o.status === 'fulfilled' && o.value) this.state.openai = o.value;
      if (u.status === 'fulfilled' && u.value) this.state.cursor = u.value;
      this.onUpdate(this.state);
    } finally {
      this._pollInFlight = false;
    }
  }

  // Returns the service that is currently burning tokens, or null if both idle.
  // "Active" = had a positive change rate in the last poll cycle, or changed
  // within the active window. If both are active, returns the one burning faster.
  // Falls back to the highest-utilization service so the icon is never blank.
  activeService() {
    const now  = Date.now();
    const svcs = [this.state.claude, this.state.openai, this.state.cursor]
      .filter(s => s && !s.error && s.lastFetched && (now - s.lastFetched < ACTIVE_WINDOW_MS));
    if (svcs.length === 0) return null;

    // Prefer service with a positive burn rate (something changed last cycle)
    const burning = svcs.filter(s => s.changeRate > 0);
    if (burning.length > 0) {
      return burning.sort((a, b) => b.changeRate - a.changeRate)[0];
    }

    // Nothing actively changing — return highest utilization as fallback
    return svcs.sort((a, b) => {
      const au = a.fiveHour?.utilization ?? a.utilization ?? 0;
      const bu = b.fiveHour?.utilization ?? b.utilization ?? 0;
      return bu - au;
    })[0];
  }

  start() {
    const pollMs = this.store.get('poll_interval_ms', 90 * 1000); // default 90s
    this.poll();
    this.timer = setInterval(() => this.poll(), pollMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  restart() {
    this.stop();
    this.start();
  }

  getState() { return this.state; }
}

module.exports = Poller;
