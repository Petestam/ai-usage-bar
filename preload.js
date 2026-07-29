const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiUsage', {
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
  refresh: () => ipcRenderer.invoke('refresh'),
  resize: (height) => ipcRenderer.invoke('resize', height),
  quit: () => ipcRenderer.invoke('quit-app'),
  getSettingsDiagnostics: () => ipcRenderer.invoke('get-settings-diagnostics'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUsageUpdate: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('usage-update', handler);
    return () => ipcRenderer.removeListener('usage-update', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
