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

function isSessionCookie(serviceId, cookie) {
  if (!cookie?.name || !cookie.value) return false;
  if (serviceId === 'claude') return cookie.name === 'sessionKey';
  if (serviceId === 'cursor') return cookie.name === 'WorkosCursorSessionToken';
  if (serviceId === 'codex') return cookie.name.startsWith('__Secure-next-auth.session-token');
  return false;
}

function sessionFingerprint(serviceId, cookies) {
  return (cookies || [])
    .filter((c) => isSessionCookie(serviceId, c))
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join('\n');
}

function fingerprintFromHeader(serviceId, header) {
  if (!header) return '';
  const cookies = String(header).split(';').map((part) => {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i <= 0) return null;
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  }).filter(Boolean);
  return sessionFingerprint(serviceId, cookies);
}

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
 * @param {string} [existingCookie] credential already stored; an unchanged session is not saved again
 * @returns {Promise<{ status: 'saved'|'closed'|'error', error?: string|null, errorDetail?: string|null }>}
 */
function beginSignIn(serviceId, onCaptured, existingCookie) {
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

  let resolveSignIn;
  const promise = new Promise((resolve) => {
    resolveSignIn = resolve;
  });
  const entry = { win: null, promise };
  inflight.set(serviceId, entry);

  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(site.partition);
  if (typeof ses.setUserAgent === 'function') ses.setUserAgent(CHROME_UA);

  let settled = false;
  let checking = false;
  let saving = false;
  let timer = null;
  let pending = null;
  let baseline = fingerprintFromHeader(serviceId, existingCookie);

  function cleanupListeners() {
    if (timer) clearInterval(timer);
    timer = null;
    if (pending) clearTimeout(pending);
    pending = null;
    ses.cookies.removeListener('changed', onCookieChanged);
  }

  function finish(status, extra) {
    if (settled) return;
    settled = true;
    cleanupListeners();
    inflight.delete(serviceId);
    resolveSignIn(Object.assign({ status }, extra && typeof extra === 'object' ? extra : {}));
  }

  function scheduleSave() {
    if (pending || settled) return;
    // Sharded session cookies (.0, .1) arrive a moment apart.
    pending = setTimeout(() => {
      pending = null;
      commit();
    }, 800);
  }

  async function commit() {
    if (settled || checking || !entry.win || entry.win.isDestroyed()) return;
    checking = true;
    try {
      const cookies = await ses.cookies.get({ url: site.cookieUrl });
      if (settled || !site.ready(cookies)) return;
      const fp = sessionFingerprint(serviceId, cookies);
      if (!fp || fp === baseline) return;
      const header = formatCookieHeader(cookies);
      if (!header) return;
      saving = true;
      const outcome = await onCaptured(site.configKey, header);
      // Rejected session: keep the window open until the cookie changes again.
      if (outcome?.error === 'auth_expired') {
        baseline = fp;
        if (entry.win && !entry.win.isDestroyed()) {
          entry.win.setTitle(`${site.title} — session was not accepted`);
          entry.win.show();
          entry.win.focus();
        }
        return;
      }
      finish('saved', outcome);
      if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    } catch {
      const win = entry.win;
      if (!win || win.isDestroyed()) finish('closed');
    } finally {
      saving = false;
      checking = false;
    }
  }

  function check() {
    if (settled || checking) return;
    ses.cookies.get({ url: site.cookieUrl }).then((cookies) => {
      if (settled || !site.ready(cookies)) return;
      const fp = sessionFingerprint(serviceId, cookies);
      if (!fp || fp === baseline) return;
      scheduleSave();
    }).catch(() => {});
  }

  function onCookieChanged(_event, cookie, _cause, removed) {
    if (removed || !cookie) return;
    check();
  }

  (async () => {
    const current = await ses.cookies.get({ url: site.cookieUrl });
    const currentFp = sessionFingerprint(serviceId, current);
    // Same cookie that just expired: drop it and wait for a real login.
    if (currentFp && baseline && currentFp === baseline) {
      await ses.clearStorageData();
    }

    const win = new BrowserWindow({
      width: 960,
      height: 760,
      title: site.title,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    entry.win = win;
    win.webContents.setUserAgent(CHROME_UA);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
      setTimeout(() => {
        if (!win.isDestroyed()) win.setAlwaysOnTop(false);
      }, 400);
    });

    ses.cookies.on('changed', onCookieChanged);
    win.webContents.on('did-navigate', () => check());
    win.webContents.on('did-navigate-in-page', () => check());
    win.webContents.on('did-finish-load', () => check());

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
  })().catch(() => finish('error'));

  return promise;
}

module.exports = {
  CHROME_UA,
  SITES,
  formatCookieHeader,
  sessionFingerprint,
  fingerprintFromHeader,
  beginSignIn,
};
