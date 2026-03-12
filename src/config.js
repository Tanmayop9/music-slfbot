/**
 * Config loader — loads config.json from the project root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('config');

export function loadConfig() {
  const jsonPath = path.resolve('config.json');

  if (!fs.existsSync(jsonPath)) {
    log.error(
      'No config file found.\n'
      + 'Copy config.example.json → config.json and fill in your details.',
    );
    process.exit(1);
  }

  try {
    const text = fs.readFileSync(jsonPath, 'utf8');
    const cfg  = JSON.parse(text);
    cfg._configPath = jsonPath;
    return cfg;
  } catch (err) {
    log.error(`Failed to parse config.json: ${err.message}`);
    process.exit(1);
  }
}
