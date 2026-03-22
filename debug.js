const fs = require('fs');
const path = require('path');

let logFilePath;

/** In-memory tail for the Settings “Troubleshooting” panel (no secrets). */
const SETTINGS_LOG_MAX = 100;
const settingsLogLines = [];

function getLogPath() {
  return logFilePath;
}

function getSettingsLogLines() {
  return [...settingsLogLines];
}

/** Logs to stderr, ai-usage-debug.log, and the settings troubleshooting buffer. */
function logSettings(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(formatArg).join(' ')}`;
  settingsLogLines.push(line);
  while (settingsLogLines.length > SETTINGS_LOG_MAX) settingsLogLines.shift();
  log(...args);
}

function init(app) {
  logFilePath = path.join(app.getPath('userData'), 'ai-usage-debug.log');
  const header = `\n--- ${new Date().toISOString()} pid=${process.pid} ---\n`;
  try {
    fs.appendFileSync(logFilePath, header, 'utf8');
  } catch (e) {
    process.stderr.write(`[ai-usage-bar] could not write log file: ${e.message}\n`);
  }
  log('debug init', {
    userData: app.getPath('userData'),
    logFile: logFilePath,
    execPath: process.execPath,
    cwd: process.cwd(),
    argv: process.argv,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function log(...args) {
  const line = `[${new Date().toISOString()}] [ai-usage-bar] ${args.map(formatArg).join(' ')}\n`;
  process.stderr.write(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line, 'utf8');
    } catch {
      /* ignore */
    }
  }
}

function logError(where, err) {
  log(`ERROR ${where}:`, err instanceof Error ? err : new Error(String(err)));
}

function installProcessHandlers() {
  process.on('uncaughtException', (err) => logError('uncaughtException', err));
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
}

module.exports = {
  init,
  log,
  logSettings,
  logError,
  installProcessHandlers,
  getLogPath,
  getSettingsLogLines,
};
