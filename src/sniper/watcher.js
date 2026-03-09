/**
 * Config hot-reload watcher.
 * Polls the config file every `interval` seconds and calls `onChange(newCfg)`
 * whenever the file's hash changes.
 *
 * Supports both YAML (config.yaml, requires js-yaml) and JSON (config.json, built-in).
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('ConfigWatcher');

export class ConfigWatcher {
  /**
   * @param {string} filePath
   * @param {(newCfg: object) => void} onChange
   * @param {number} intervalMs  polling interval in milliseconds (default 2000)
   */
  constructor(filePath, onChange, intervalMs = 2000) {
    this._path       = path.resolve(filePath);
    this._onChange   = onChange;
    this._intervalMs = intervalMs;
    this._lastHash   = null;
    this._timer      = null;
    this._running    = false;
  }

  start() {
    this._running = true;
    this._poll();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _poll() {
    if (!this._running) return;
    try {
      const currentHash = this._fileHash();
      if (currentHash !== this._lastHash) {
        if (this._lastHash !== null) {
          const newCfg = await this._load();
          if (newCfg !== null) {
            log.info('[ConfigWatcher] Config changed — hot-reloading sniper targets');
            this._onChange(newCfg);
          }
        }
        this._lastHash = currentHash;
      }
    } catch (err) {
      log.error(`[ConfigWatcher] error: ${err.message}`);
    }
    this._timer = setTimeout(() => this._poll(), this._intervalMs);
  }

  _fileHash() {
    const data = fs.readFileSync(this._path);
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async _load() {
    try {
      const ext  = path.extname(this._path).toLowerCase();
      const text = fs.readFileSync(this._path, 'utf8');
      if (ext === '.json') {
        return JSON.parse(text);
      }
      // Default: treat as YAML
      let yaml;
      try {
        yaml = await import('js-yaml');
      } catch {
        log.error('[ConfigWatcher] js-yaml not installed; cannot hot-reload YAML config.');
        return null;
      }
      return yaml.default.load(text);
    } catch (err) {
      log.error(`[ConfigWatcher] parse error: ${err.message}`);
      return null;
    }
  }
}
