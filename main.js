const { app, ipcMain } = require('electron');
if (!app?.whenReady) {
  process.stderr.write(
    '[ai-usage-bar] Must be started with Electron (e.g. npm start), not plain Node.\n'
  );
  process.exit(1);
}
const { menubar }      = require('menubar');
const path             = require('path');
const Store            = require('./store');
const Poller           = require('./poller');
const debug            = require('./debug');
const {
  createBatteryIcon,
  iconFromServiceData,
  describeNativeImage,
  usageLabelForService,
} = require('./icon');

function buildTrayTooltip(state) {
  const bits = [];
  if (state.claude && !state.claude.error) {
    bits.push(`Claude 5h ${Math.round(state.claude.fiveHour?.utilization ?? 0)}%`);
  }
  if (state.openai && !state.openai.error) {
    bits.push(`OpenAI month ${Math.round(state.openai.utilization ?? 0)}%`);
  }
  return bits.length ? bits.join(' · ') : 'AI Usage';
}

debug.installProcessHandlers();

let mb;
let poller;
let store;

app.whenReady().then(() => {
  debug.init(app);
  debug.log('app whenReady');

  store  = new Store();
  const idleIcon = createBatteryIcon(0, 'idle');
  debug.log('idle tray icon:', describeNativeImage(idleIcon));

  try {
    mb = menubar({
      icon: idleIcon,
      index: `file://${path.join(__dirname, 'renderer/popover.html')}`,
      browserWindow: {
        width:     320,
        height:    290,
        resizable: false,
        webPreferences: {
          nodeIntegration:  true,
          contextIsolation: false,
        },
      },
      preloadWindow: true,
      showDockIcon:  false,
    });
    debug.log('menubar() returned OK');
  } catch (e) {
    debug.logError('menubar()', e);
    throw e;
  }

  mb.on('ready', () => {
    debug.log('menubar ready');
    try {
      const bounds = mb.tray.getBounds();
      debug.log('tray getBounds:', bounds);
      const tip = mb.tray.getToolTip?.();
      if (tip !== undefined) debug.log('tray tooltip:', JSON.stringify(tip));
    } catch (e) {
      debug.logError('tray inspect', e);
    }

    if (process.platform === 'darwin' && typeof mb.tray.setTitle === 'function') {
      mb.tray.setTitle('');
    }

    poller = new Poller(store, (state) => {
      // Update tray icon with the active service's battery level + usage label.
      // If nothing is active, show idle (dim battery, no label).
      const active = poller.activeService();
      const next = active ? iconFromServiceData(active) : createBatteryIcon(0, 'idle');
      if (next.isEmpty()) {
        debug.log('WARNING: setImage with empty icon', describeNativeImage(next));
      }
      mb.tray.setImage(next);
      if (typeof mb.tray.setToolTip === 'function') {
        mb.tray.setToolTip(buildTrayTooltip(state));
      }
      // macOS: native menu bar text for consumed %; bitmap is only `[████░░]`.
      if (process.platform === 'darwin' && typeof mb.tray.setTitle === 'function') {
        const title = active && !active.error ? ` ${usageLabelForService(active)}` : '';
        mb.tray.setTitle(title);
      }

      // Forward state to the open popover (no-op if window is hidden).
      if (mb.window?.webContents) {
        mb.window.webContents.send('usage-update', state);
      }
    });

    poller.start();
    debug.log('poller started');
  });

  mb.on('after-create-window', () => {
    debug.log('menubar after-create-window', {
      hasWindow: !!mb.window,
      url: mb.window?.webContents?.getURL?.(),
    });
  });

  mb.on('create-window', () => debug.log('menubar create-window'));
  mb.on('before-load', () => debug.log('menubar before-load'));

  mb.on('after-show', () => debug.log('menubar after-show'));
  mb.on('after-hide', () => debug.log('menubar after-hide'));
});

// ── IPC handlers ──────────────────────────────────────────────────────────

ipcMain.handle('get-state', () => poller?.getState() || {});

ipcMain.handle('get-config', () => store.getAll());

ipcMain.handle('set-config', (_, incoming) => {
  const merged = { ...store.getAll(), ...incoming };
  store.setAll(merged);
  // Reset cached org UUID so Claude re-discovers on next poll.
  if (poller) {
    poller.claude.orgUuid = null;
    poller.restart();
  }
});

ipcMain.handle('refresh', async () => {
  await poller?.poll();
  return poller?.getState();
});

ipcMain.handle('resize', (_, height) => {
  if (mb.window) mb.window.setSize(320, height);
});

// Prevent quitting when all windows close (menubar convention).
app.on('window-all-closed', (e) => e.preventDefault());
