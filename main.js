const { app, ipcMain, Menu, safeStorage } = require('electron');
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
const { startUpdater, registerUpdaterIpc, onStatus } = require('./updater');
const { beginSignIn } = require('./providers/cookie-login');

function gaugeHiddenClaude() {
  return !!store?.get('hide_claude_gauge');
}
function gaugeHiddenOpenAI() {
  return !!store?.get('hide_openai_gauge');
}
function gaugeHiddenCursor() {
  return !!store?.get('hide_cursor_gauge');
}
function gaugeHiddenCodex() {
  return !!store?.get('hide_codex_gauge');
}

function buildTrayTooltip(state) {
  const bits = [];
  if (state.claude && !state.claude.error && !gaugeHiddenClaude()) {
    const g = Math.round(
      state.claude.gaugeUtilization ?? state.claude.fiveHour?.utilization ?? 0
    );
    let line = `Claude ${g}%`;
    const ca = state.claude.consoleApi;
    if (ca && !ca.error && ca.spendMtdUsd != null) {
      line += ` · API $${ca.spendMtdUsd.toFixed(2)}`;
      if (ca.spendLimitUsd != null) line += ` / $${ca.spendLimitUsd.toFixed(0)}`;
    }
    bits.push(line);
  }
  if (state.openai && !state.openai.error && !gaugeHiddenOpenAI()) {
    bits.push(`OpenAI month ${Math.round(state.openai.utilization ?? 0)}%`);
  }
  if (state.cursor && !state.cursor.error && !gaugeHiddenCursor()) {
    let c = `Cursor ${Math.round(state.cursor.utilization ?? 0)}%`;
    const od = state.cursor.onDemand;
    if (od && (od.unlimited || (od.limitCents ?? 0) > 0 || (od.usedCents ?? 0) > 0)) {
      const spent = ((od.usedCents ?? 0) / 100).toFixed(2);
      if (od.unlimited) {
        c += ` · on-demand $${spent}`;
      } else if (od.limitCents > 0) {
        c += ` · $${spent}/$${(od.limitCents / 100).toFixed(2)}`;
      } else if ((od.usedCents ?? 0) > 0) {
        c += ` · on-demand $${spent}`;
      }
    }
    bits.push(c);
  }
  if (state.codex && !state.codex.error && !gaugeHiddenCodex()) {
    const g = Math.round(
      state.codex.gaugeUtilization ?? state.codex.fiveHour?.utilization ?? state.codex.utilization ?? 0
    );
    bits.push(`Codex ${g}%`);
  }
  return bits.length ? bits.join(' · ') : 'AI Usage';
}

debug.installProcessHandlers();

let mb;
let poller;
let store;
let lastTrayIconKey = null;
let lastTrayTooltip = null;
let lastTrayTitle = null;
let lastWindowHeight = null;

/** Poll state + per-provider gauge visibility for the popover */
function stateForRenderer() {
  const state = poller?.getState() || {};
  return {
    ...state,
    gaugeHidden: {
      claude: !!store?.get('hide_claude_gauge'),
      openai: !!store?.get('hide_openai_gauge'),
      cursor: !!store?.get('hide_cursor_gauge'),
      codex: !!store?.get('hide_codex_gauge'),
    },
  };
}

app.whenReady().then(() => {
  debug.init(app);
  debug.log('app whenReady');

  store  = new Store();
  debug.log(
    'safeStorage encryption:',
    typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  );
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
          preload: path.join(__dirname, 'preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
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
    lastTrayTitle = '';

    // Right-click only — setContextMenu also fires on left-click with menubar.
    const trayMenu = Menu.buildFromTemplate([
      {
        label: 'Refresh',
        click: () => {
          poller?.poll().catch((e) => debug.logError('tray refresh', e));
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);
    mb.tray.on('right-click', (_event, bounds) => {
      mb.tray.popUpContextMenu(trayMenu, bounds);
    });

    poller = new Poller(store, (state) => {
      // Update tray icon with the active service's capacity ring + in-icon %.
      // If nothing is active, show idle (dim empty ring).
      const active = poller.activeService();
      const iconKey = active && !active.error
        ? `${active.service}:${usageLabelForService(active)}`
        : 'idle';
      const next = active ? iconFromServiceData(active) : createBatteryIcon(0, 'idle');
      if (next.isEmpty()) {
        debug.log('WARNING: setImage with empty icon', describeNativeImage(next));
      }
      if (iconKey !== lastTrayIconKey) {
        mb.tray.setImage(next);
        lastTrayIconKey = iconKey;
      }
      if (typeof mb.tray.setToolTip === 'function') {
        const tip = buildTrayTooltip(state);
        if (tip !== lastTrayTooltip) {
          mb.tray.setToolTip(tip);
          lastTrayTooltip = tip;
        }
      }
      // % lives inside the ring icon — keep tray title empty to save menubar space.
      if (process.platform === 'darwin' && typeof mb.tray.setTitle === 'function' && lastTrayTitle !== '') {
        mb.tray.setTitle('');
        lastTrayTitle = '';
      }

      // Forward state to the open popover (no-op if window is hidden).
      if (mb.window?.webContents && mb.window.isVisible()) {
        mb.window.webContents.send('usage-update', stateForRenderer());
      }
    });

    poller.start();
    debug.log('poller started');

    startUpdater({ log: (...a) => debug.log(...a) });
    onStatus((update) => {
      if (mb.window?.webContents) {
        mb.window.webContents.send('update-status', update);
      }
    });
    debug.log('updater started');
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

ipcMain.handle('get-state', () => stateForRenderer());

ipcMain.handle('get-config', () => store.getPublic());

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

  if ('cursor_cookie' in incoming) {
    const v = incoming.cursor_cookie;
    if (v && String(v).trim()) {
      merged.cursor_cookie = String(v).trim();
    } else {
      delete merged.cursor_cookie;
    }
  }

  if ('codex_cookie' in incoming) {
    const v = incoming.codex_cookie;
    if (v && String(v).trim()) {
      merged.codex_cookie = String(v).trim();
    } else {
      delete merged.codex_cookie;
    }
  }

  if ('anthropic_admin_api_key' in incoming) {
    const v = incoming.anthropic_admin_api_key;
    if (v && String(v).trim()) {
      merged.anthropic_admin_api_key = String(v).trim();
    } else {
      delete merged.anthropic_admin_api_key;
    }
  }

  if ('anthropic_api_spend_limit_usd' in incoming) {
    const v = incoming.anthropic_api_spend_limit_usd;
    if (v === '' || v == null) {
      delete merged.anthropic_api_spend_limit_usd;
    } else {
      const n = parseFloat(String(v));
      if (Number.isFinite(n) && n >= 0) merged.anthropic_api_spend_limit_usd = n;
    }
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
    cursor_cookie: incoming.cursor_cookie
      ? `updated (length ${incoming.cursor_cookie.length})`
      : 'unchanged',
    codex_cookie: incoming.codex_cookie
      ? `updated (length ${incoming.codex_cookie.length})`
      : 'unchanged',
    anthropic_admin_api_key: incoming.anthropic_admin_api_key
      ? `updated (length ${incoming.anthropic_admin_api_key.length})`
      : 'unchanged',
    anthropic_api_spend_limit_usd:
      incoming.anthropic_api_spend_limit_usd !== undefined
        ? incoming.anthropic_api_spend_limit_usd
        : 'unchanged',
    hide_claude_gauge: incoming.hide_claude_gauge !== undefined ? !!incoming.hide_claude_gauge : 'unchanged',
    hide_openai_gauge: incoming.hide_openai_gauge !== undefined ? !!incoming.hide_openai_gauge : 'unchanged',
    hide_cursor_gauge: incoming.hide_cursor_gauge !== undefined ? !!incoming.hide_cursor_gauge : 'unchanged',
    hide_codex_gauge: incoming.hide_codex_gauge !== undefined ? !!incoming.hide_codex_gauge : 'unchanged',
  });
  if ('hide_claude_gauge' in incoming) merged.hide_claude_gauge = !!incoming.hide_claude_gauge;
  if ('hide_openai_gauge' in incoming) merged.hide_openai_gauge = !!incoming.hide_openai_gauge;
  if ('hide_cursor_gauge' in incoming) merged.hide_cursor_gauge = !!incoming.hide_cursor_gauge;
  if ('hide_codex_gauge' in incoming) merged.hide_codex_gauge = !!incoming.hide_codex_gauge;
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
      cursor: svc(st.cursor),
      codex: svc(st.codex),
    },
  };
});

ipcMain.handle('sign-in', async (_event, serviceId) => {
  if (!store) return { status: 'error' };
  return beginSignIn(serviceId, async (configKey, cookieHeader) => {
    const merged = { ...store.getAll(), [configKey]: cookieHeader };
    if (configKey === 'claude_session_key') {
      delete merged.claude_org_uuid;
      if (poller?.claude) poller.claude.orgUuid = null;
    }
    store.setAll(merged);
    debug.logSettings('sign-in', configKey, `saved (length ${cookieHeader.length})`);
    await poller?.poll();
    try {
      if (mb?.window && !mb.window.isDestroyed()) {
        mb.window.webContents.send('usage-update', stateForRenderer());
      }
    } catch (e) {
      debug.logError('sign-in usage-update', e);
    }
  });
});

ipcMain.handle('refresh', async () => {
  await poller?.poll();
  return stateForRenderer();
});

ipcMain.handle('resize', (_, height) => {
  if (!mb.window) return;
  const { screen } = require('electron');
  const maxH = Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.92);
  const h = Math.min(Math.max(120, Math.round(height)), maxH);
  if (h === lastWindowHeight) return;
  lastWindowHeight = h;
  mb.window.setSize(320, h);
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

registerUpdaterIpc();

// Prevent quitting when all windows close (menubar convention).
app.on('window-all-closed', (e) => e.preventDefault());
