// Opens a per-service login window and reads that window's cookies.
// The cookie header stays in the main process; callers persist it.

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITES = {
  claude: {
    url: 'https://claude.ai/login',
    cookieUrl: 'https://claude.ai',
    partition: 'persist:ai-usage-claude',
    title: 'Sign in to Claude',
    configKey: 'claude_session_key',
    ready(cookies) {
      return cookies.some((c) => c.name === 'sessionKey' && c.value);
    },
  },
  cursor: {
    url: 'https://cursor.com/dashboard',
    cookieUrl: 'https://cursor.com',
    partition: 'persist:ai-usage-cursor',
    title: 'Sign in to Cursor',
    configKey: 'cursor_cookie',
    ready(cookies) {
      return cookies.some((c) => c.name === 'WorkosCursorSessionToken' && c.value);
    },
  },
  codex: {
    url: 'https://chatgpt.com/',
    cookieUrl: 'https://chatgpt.com',
    partition: 'persist:ai-usage-codex',
    title: 'Sign in to ChatGPT',
    configKey: 'codex_cookie',
    ready(cookies) {
      return cookies.some(
        (c) => c.name.startsWith('__Secure-next-auth.session-token') && c.value
      );
    },
  },
};

function formatCookieHeader(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

const inflight = new Map();

/**
 * @param {string} serviceId claude | cursor | codex
 * @param {(configKey: string, cookieHeader: string) => Promise<void>|void} onCaptured
 * @returns {Promise<{ status: 'saved'|'closed'|'error' }>}
 */
function beginSignIn(serviceId, onCaptured) {
  const site = SITES[serviceId];
  if (!site || typeof onCaptured !== 'function') {
    return Promise.resolve({ status: 'error' });
  }

  const existing = inflight.get(serviceId);
  if (existing) {
    if (existing.win && !existing.win.isDestroyed()) {
      existing.win.show();
      existing.win.focus();
    }
    return existing.promise;
  }

  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(site.partition);
  if (typeof ses.setUserAgent === 'function') ses.setUserAgent(CHROME_UA);

  const win = new BrowserWindow({
    width: 960,
    height: 760,
    title: site.title,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setUserAgent(CHROME_UA);

  let settled = false;
  let checking = false;
  let saving = false;
  let timer = null;

  let resolveSignIn;
  const promise = new Promise((resolve) => {
    resolveSignIn = resolve;
  });
  inflight.set(serviceId, { win, promise });

  function cleanupListeners() {
    if (timer) clearInterval(timer);
    timer = null;
    ses.cookies.removeListener('changed', onCookieChanged);
  }

  function finish(status) {
    if (settled) return;
    settled = true;
    cleanupListeners();
    inflight.delete(serviceId);
    resolveSignIn({ status });
  }

  async function check() {
    if (settled || checking || win.isDestroyed()) return;
    checking = true;
    try {
      const cookies = await ses.cookies.get({ url: site.cookieUrl });
      if (settled || !site.ready(cookies)) return;
      const header = formatCookieHeader(cookies);
      if (!header) return;
      saving = true;
      await onCaptured(site.configKey, header);
      finish('saved');
      if (!win.isDestroyed()) win.close();
    } catch {
      // Save failed, or the window closed mid-save. Retry only if it is still open.
      if (win.isDestroyed()) finish('closed');
    } finally {
      saving = false;
      checking = false;
    }
  }

  function onCookieChanged(_event, cookie, _cause, removed) {
    if (removed || !cookie) return;
    check();
  }

  ses.cookies.on('changed', onCookieChanged);
  win.webContents.on('did-navigate', () => check());
  win.webContents.on('did-navigate-in-page', () => check());
  win.webContents.on('did-finish-load', () => check());

  // OAuth often opens a second window. Keep it in this partition.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      },
    };
  });
  win.webContents.on('did-create-window', (child) => {
    try {
      child.webContents.setUserAgent(CHROME_UA);
    } catch {
      /* child may already be destroyed */
    }
  });

  win.on('closed', () => {
    if (!saving) finish('closed');
  });

  timer = setInterval(() => check(), 1000);
  win.loadURL(site.url).catch(() => {});

  return promise;
}

module.exports = {
  CHROME_UA,
  SITES,
  formatCookieHeader,
  beginSignIn,
};
