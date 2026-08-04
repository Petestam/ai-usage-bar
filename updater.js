const { app, ipcMain } = require('electron');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours
const STARTUP_DELAY_MS = 15_000;

let status = {
  state: 'idle', // idle | checking | available | downloading | ready | up-to-date | error | dev
  currentVersion: null,
  latestVersion: null,
  percent: null,
  message: null,
};

let listeners = [];
let checkTimer = null;
let started = false;

function currentVersion() {
  try {
    return app.getVersion();
  } catch (_) {
    return null;
  }
}

function emit() {
  for (const fn of listeners) {
    try {
      fn({ ...status });
    } catch (_) {}
  }
}

function setStatus(patch) {
  status = { ...status, currentVersion: currentVersion(), ...patch };
  emit();
}

function getStatus() {
  return { ...status, currentVersion: status.currentVersion || currentVersion() };
}

function onStatus(fn) {
  listeners.push(fn);
  fn(getStatus());
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

async function checkNow() {
  if (!app.isPackaged) {
    setStatus({ state: 'dev', message: 'Updates only run in packaged builds' });
    return null;
  }
  const { autoUpdater } = require('electron-updater');
  setStatus({ state: 'checking', message: null, percent: null });
  try {
    return await autoUpdater.checkForUpdates();
  } catch (e) {
    setStatus({ state: 'error', message: String(e?.message || e) });
    return null;
  }
}

function quitAndInstall() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  // isSilent, isForceRunAfter
  autoUpdater.quitAndInstall(false, true);
}

function startUpdater({ log = () => {} } = {}) {
  if (started) return { getStatus, onStatus, checkNow, quitAndInstall };
  started = true;

  status.currentVersion = currentVersion();

  if (!app.isPackaged) {
    setStatus({ state: 'dev', message: 'Dev mode — auto-update disabled' });
    return { getStatus, onStatus, checkNow, quitAndInstall };
  }

  const { autoUpdater } = require('electron-updater');
  // Releases are unsigned until Developer ID + notarization is set up.
  // ShipIt rejects unsigned updates unless this is disabled.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (...a) => log('[updater]', ...a),
    warn: (...a) => log('[updater:warn]', ...a),
    error: (...a) => log('[updater:error]', ...a),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', message: null, percent: null });
  });

  autoUpdater.on('update-available', (info) => {
    setStatus({
      state: 'available',
      latestVersion: info?.version || null,
      message: `Downloading ${info?.version || 'update'}…`,
      percent: 0,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    setStatus({
      state: 'up-to-date',
      latestVersion: info?.version || currentVersion(),
      message: null,
      percent: null,
    });
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus({
      state: 'downloading',
      percent: Math.round(p?.percent ?? 0),
      message: `Downloading… ${Math.round(p?.percent ?? 0)}%`,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      state: 'ready',
      latestVersion: info?.version || status.latestVersion,
      percent: 100,
      message: 'Update ready — restarts on Quit, or tap Restart now',
    });
  });

  autoUpdater.on('error', (err) => {
    setStatus({
      state: 'error',
      message: String(err?.message || err),
      percent: null,
    });
  });

  const tick = () => {
    checkNow().catch((e) => log('[updater] check failed', e));
  };

  setTimeout(tick, STARTUP_DELAY_MS);
  checkTimer = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof checkTimer.unref === 'function') checkTimer.unref();

  return { getStatus, onStatus, checkNow, quitAndInstall };
}

function registerUpdaterIpc() {
  ipcMain.handle('get-update-status', () => getStatus());
  ipcMain.handle('check-for-updates', () => checkNow().then(() => getStatus()));
  ipcMain.handle('install-update', () => {
    quitAndInstall();
    return true;
  });
}

module.exports = {
  startUpdater,
  registerUpdaterIpc,
  getStatus,
  onStatus,
  checkNow,
  quitAndInstall,
};
