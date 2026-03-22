const { app } = require('electron');
const fs = require('fs');
const path = require('path');

class Store {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'ai-usage-config.json');
    this._data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return {};
    }
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this._data, null, 2));
  }

  get(key, defaultValue = undefined) {
    return this._data[key] !== undefined ? this._data[key] : defaultValue;
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  getAll() {
    return { ...this._data };
  }

  setAll(data) {
    this._data = { ...data };
    this._save();
  }
}

module.exports = Store;
