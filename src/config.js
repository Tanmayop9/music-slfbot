/**
 * Config loader — supports config.yaml (preferred) or config.json (fallback).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('config');

export async function loadConfig() {
  const yamlPath = path.resolve('config.yaml');
  const jsonPath = path.resolve('config.json');

  // Try YAML first
  if (fs.existsSync(yamlPath)) {
    let yaml;
    try {
      yaml = await import('js-yaml');
    } catch {
      log.warn(
        'js-yaml is not installed — falling back to JSON config.\n'
        + 'Install it: npm install js-yaml\n'
        + 'Or use config.json instead.',
      );
    }

    if (yaml) {
      try {
        const text = fs.readFileSync(yamlPath, 'utf8');
        const cfg  = yaml.default.load(text);
        cfg._configPath = yamlPath;
        return cfg;
      } catch (err) {
        log.error(`Failed to parse config.yaml: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // Fallback: JSON config
  if (fs.existsSync(jsonPath)) {
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

  // Neither found
  if (fs.existsSync(yamlPath)) {
    log.error(
      'config.yaml found but js-yaml is not installed.\n'
      + 'Install it: npm install js-yaml\n'
      + 'Or rename config.example.json to config.json and fill in your details.',
    );
  } else {
    log.error(
      'No config file found.\n'
      + 'Copy config.example.yaml → config.yaml\n'
      + '  (or config.example.json → config.json)\n'
      + 'and fill in your details.',
    );
  }
  process.exit(1);
}
