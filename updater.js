const { app, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

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
let macUpdateZip = null;
let macInstallStarted = false;

// Squirrel.Mac validates the new app with kSecCSStrictValidate, which rejects
// an unsigned or ad-hoc bundle ("code object is not signed at all"). That check
// cannot be turned off. On Mac we download with electron-updater, then swap the
// .app ourselves after quit.
const MAC_INSTALL_SCRIPT = `set -euo pipefail
LOG="$HOME/Library/Logs/ai-usage-update.log"
mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1
echo "--- $(date) replacing $APP_BUNDLE ---"
while kill -0 "$APP_PID" 2>/dev/null; do sleep 0.2; done
TMP=$(mktemp -d)
ditto -x -k "$UPDATE_ZIP" "$TMP"
NEW=$(find "$TMP" -maxdepth 2 -name '*.app' -print -quit || true)
if [ -z "$NEW" ]; then
  echo "no .app in $UPDATE_ZIP"
  rm -rf "$TMP"
  exit 1
fi
BACKUP="\${APP_BUNDLE}.previous"
rm -rf "$BACKUP"
mv "$APP_BUNDLE" "$BACKUP"
if ! mv "$NEW" "$APP_BUNDLE"; then
  mv "$BACKUP" "$APP_BUNDLE"
  rm -rf "$TMP"
  exit 1
fi
rm -rf "$BACKUP" "$TMP"
xattr -dr com.apple.quarantine "$APP_BUNDLE" || true
open "$APP_BUNDLE"
`;

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

function appBundlePath() {
  // .../AI Usage.app/Contents/MacOS/AI Usage → .../AI Usage.app
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

function installMacUpdate() {
  if (!macUpdateZip || macInstallStarted) return;
  const bundle = appBundlePath();
  if (!bundle.endsWith('.app')) return;
  macInstallStarted = true;
  const child = spawn('/bin/bash', ['-c', MAC_INSTALL_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      UPDATE_ZIP: macUpdateZip,
      APP_BUNDLE: bundle,
      APP_PID: String(process.pid),
    },
  });
  child.unref();
  app.exit(0);
}

function quitAndInstall() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    installMacUpdate();
    return;
  }
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
  // Squirrel.Mac still rejects unsigned bundles. Mac installs swap the .app
  // after quit instead of calling ShipIt. Windows keeps electron-updater's installer.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';
  if (process.platform === 'darwin') {
    app.on('before-quit', (event) => {
      if (!macUpdateZip || macInstallStarted) return;
      if (!appBundlePath().endsWith('.app')) return;
      event.preventDefault();
      installMacUpdate();
    });
  }
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
    if (process.platform === 'darwin' && info?.downloadedFile) {
      macUpdateZip = info.downloadedFile;
    }
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
