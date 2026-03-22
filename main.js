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

  if ('claude_org_uuid' in incoming) {
    const v = incoming.claude_org_uuid;
    if (v && String(v).trim()) {
      merged.claude_org_uuid = String(v).trim();
    } else {
      delete merged.claude_org_uuid;
    }
  }

  // New session key → drop saved org so we do not reuse the wrong org; user can re-add org ID after.
  if (incoming.claude_session_key) {
    delete merged.claude_org_uuid;
  }

  debug.logSettings('set-config', {
    claude_session_key: incoming.claude_session_key
      ? `${incoming.claude_session_key.includes(';') ? 'cookie header' : 'session key'} (length ${incoming.claude_session_key.length})`
      : 'unchanged',
    claude_org_uuid: incoming.claude_org_uuid !== undefined
      ? merged.claude_org_uuid || '(cleared)'
      : 'unchanged',
    openai_api_key: incoming.openai_api_key
      ? `updated (length ${incoming.openai_api_key.length})`
      : 'unchanged',
    openai_manual_limit: incoming.openai_manual_limit !== undefined
      ? incoming.openai_manual_limit
      : 'unchanged',
  });
  store.setAll(merged);

  if (poller) {
    if (incoming.claude_session_key) {
      poller.claude.orgUuid = null;
    } else if ('claude_org_uuid' in incoming) {
      poller.claude.orgUuid = merged.claude_org_uuid || null;
    }
    poller.restart();
  }
});

ipcMain.handle('get-settings-diagnostics', () => {
  const st = poller?.getState() || {};
  const svc = (s) =>
    s
      ? {
          error: s.error,
          errorDetail: s.errorDetail,
          lastFetched: s.lastFetched,
        }
      : null;
  return {
    configPath: store?.getConfigPath(),
    debugLogPath: debug.getLogPath(),
    logLines: debug.getSettingsLogLines(),
    services: {
      claude: svc(st.claude),
      openai: svc(st.openai),
    },
  };
});

ipcMain.handle('refresh', async () => {
  await poller?.poll();
  return poller?.getState();
});

ipcMain.handle('resize', (_, height) => {
  if (mb.window) mb.window.setSize(320, height);
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Prevent quitting when all windows close (menubar convention).
app.on('window-all-closed', (e) => e.preventDefault());
