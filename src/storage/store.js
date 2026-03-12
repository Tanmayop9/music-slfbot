/**
 * Atomic async JSON key-value store.
 *
 * Design choices for speed and safety:
 *   - All data kept in a plain object in memory → O(1) get with zero I/O
 *   - Every mutation is flushed to disk atomically (write temp → rename)
 *     so the file is never partially written
 *   - A simple promise-based mutex serialises concurrent writes
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('JSONStore');

/**
 * Simple promise-based mutex (serialises concurrent writes).
 */
class Mutex {
  constructor() {
    this._queue = Promise.resolve();
  }

  lock(fn) {
    const result = this._queue.then(() => fn());
    this._queue = result.catch(() => {});
    return result;
  }
}

export class JSONStore {
  /**
   * @param {string} filePath  Path to the JSON file (created on first write).
   */
  constructor(filePath) {
    this._path = path.resolve(filePath);
    this._data = {};
    this._mutex = new Mutex();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load() {
    try {
      const raw = await fsp.readFile(this._path, 'utf8');
      this._data = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._data = {};
      } else {
        log.error(`Failed to load ${this._path}: ${err.message} — starting empty`);
        this._data = {};
      }
    }
  }

  // ── Read (in-memory, no I/O) ───────────────────────────────────────────────

  get(key, defaultValue = null) {
    return Object.prototype.hasOwnProperty.call(this._data, key)
      ? this._data[key]
      : defaultValue;
  }

  all() {
    return { ...this._data };
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key);
  }

  // ── Write (in-memory + async disk flush) ───────────────────────────────────

  async set(key, value) {
    return this._mutex.lock(async () => {
      this._data[key] = value;
      await this._flush();
    });
  }

  async setMany(updates) {
    return this._mutex.lock(async () => {
      Object.assign(this._data, updates);
      await this._flush();
    });
  }

  async delete(key) {
    return this._mutex.lock(async () => {
      delete this._data[key];
      await this._flush();
    });
  }

  /**
   * Atomically read-modify-write a key inside the mutex.
   * The provided function receives the current value (or `defaultValue`) and
   * must return the new value to store.  The entire read-modify-write
   * sequence is serialised so concurrent callers cannot interleave.
   *
   * @param {string}   key
   * @param {function} fn           (currentValue) => newValue
   * @param {*}        [defaultValue=null]
   * @returns {Promise<*>}  the new value
   */
  async update(key, fn, defaultValue = null) {
    return this._mutex.lock(async () => {
      const current = Object.prototype.hasOwnProperty.call(this._data, key)
        ? this._data[key]
        : defaultValue;
      const updated    = await fn(current);
      this._data[key]  = updated;
      await this._flush();
      return updated;
    });
  }

  async clear() {
    return this._mutex.lock(async () => {
      this._data = {};
      await this._flush();
    });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _flush() {
    const payload = JSON.stringify(this._data, null, 2);
    await this._atomicWrite(payload);
  }

  async _atomicWrite(data) {
    const dir = path.dirname(this._path);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await fsp.writeFile(tmpPath, data, 'utf8');
      await fsp.rename(tmpPath, this._path);
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }
  }
}
