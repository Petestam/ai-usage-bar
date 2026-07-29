const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const SECRET_KEYS = [
  'claude_session_key',
  'openai_api_key',
  'cursor_cookie',
  'codex_cookie',
  'anthropic_admin_api_key',
];

const ENC_PREFIX = 'enc:v1:';

function canEncrypt() {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptValue(plain) {
  if (plain == null || plain === '') return plain;
  if (!canEncrypt()) return String(plain);
  return ENC_PREFIX + safeStorage.encryptString(String(plain)).toString('base64');
}

function decryptValue(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored;
  if (!canEncrypt()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return undefined;
  }
}

class Store {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'ai-usage-config.json');
    this._data = this._load();
    // Migrate any plaintext secrets to encrypted form on first save opportunity.
    if (canEncrypt() && this._needsReencrypt) this._save();
  }

  _load() {
    this._needsReencrypt = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const data = { ...raw };
      for (const key of SECRET_KEYS) {
        if (data[key] == null || data[key] === '') continue;
        if (typeof data[key] === 'string' && !data[key].startsWith(ENC_PREFIX)) {
          this._needsReencrypt = true;
        }
        const plain = decryptValue(data[key]);
        if (plain === undefined) delete data[key];
        else data[key] = plain;
      }
      return data;
    } catch {
      return {};
    }
  }

  _serialized() {
    const out = { ...this._data };
    for (const key of SECRET_KEYS) {
      if (out[key] == null || out[key] === '') continue;
      out[key] = encryptValue(out[key]);
    }
    return out;
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this._serialized(), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.configPath, 0o600);
    } catch {
      /* ignore */
    }
    this._needsReencrypt = false;
  }

  get(key, defaultValue = undefined) {
    return this._data[key] !== undefined ? this._data[key] : defaultValue;
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  getConfigPath() {
    return this.configPath;
  }

  getAll() {
    return { ...this._data };
  }

  /** Renderer-safe config: secrets become presence flags only. */
  getPublic() {
    const out = { ...this._data };
    for (const key of SECRET_KEYS) {
      if (out[key]) out[key] = true;
      else delete out[key];
    }
    return out;
  }

  setAll(data) {
    this._data = { ...data };
    this._save();
  }
}

module.exports = Store;
