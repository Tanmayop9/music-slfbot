/**
 * Simple logger utility — writes to stdout and a log file.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVEL_NAMES = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
const LEVEL_VALUES = { debug: 0, info: 1, warn: 2, error: 3 };

let _level = LEVEL_VALUES['info'];
let _fileStream = null;

export function setLogLevel(level) {
  _level = LEVEL_VALUES[level] ?? LEVEL_VALUES['info'];
}

export function setLogFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
  _fileStream = fs.createWriteStream(path.resolve(filePath), { flags: 'a' });
}

function _write(level, name, msg) {
  if (LEVEL_VALUES[level] < _level) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `${ts} [${LEVEL_NAMES[level]}] ${name}: ${msg}`;
  console.log(line);
  if (_fileStream) _fileStream.write(line + '\n');
}

export function createLogger(name) {
  return {
    debug: (msg, ...args) => _write('debug', name, _fmt(msg, args)),
    info:  (msg, ...args) => _write('info',  name, _fmt(msg, args)),
    warn:  (msg, ...args) => _write('warn',  name, _fmt(msg, args)),
    error: (msg, ...args) => _write('error', name, _fmt(msg, args)),
  };
}

function _fmt(msg, args) {
  if (args.length === 0) return String(msg);
  return String(msg).replace(/%s|%d|%o|%i/g, () => {
    const val = args.shift();
    return val === undefined ? '' : String(val);
  }) + (args.length ? ' ' + args.join(' ') : '');
}
