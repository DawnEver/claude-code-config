#!/usr/bin/env node
/**
 * On Windows, uv_spawn cannot find binaries without the .cmd extension.
 * This script patches marketplace.json to append .cmd to known LSP commands.
 * Reference: https://github.com/anthropics/claude-plugins-official/issues/1432
 *
 * Manual fix (if needed):
 *   Edit ~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json
 *   Change:  "command": "typescript-language-server"
 *   To:      "command": "typescript-language-server.cmd"
 *   Same applies to pyright-langserver; rust-analyzer does not need .cmd extension.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const PATCHES = {
  'typescript-language-server': 'typescript-language-server.cmd',
  'pyright-langserver': 'pyright-langserver.cmd',
};

const MARKETPLACE_JSON = path.join(
  os.homedir(),
  '.claude', 'plugins', 'marketplaces', 'claude-plugins-official',
  '.claude-plugin', 'marketplace.json'
);

export function fixLspWindows() {
  if (process.platform !== 'win32') return;
  console.log('\n--- LSP Fix (Windows) ---');

  if (!fs.existsSync(MARKETPLACE_JSON)) {
    console.log('SKIP  LSP fix — marketplace.json not found (plugin not installed yet)');
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(MARKETPLACE_JSON, 'utf8');
  } catch (err) {
    console.log(`WARN  LSP fix — could not read marketplace.json: ${err.message}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.log(`WARN  LSP fix — could not parse marketplace.json: ${err.message}`);
    return;
  }

  let changed = 0;
  patchObject(data, PATCHES, () => changed++);

  if (changed === 0) {
    console.log('OK    LSP fix — already patched');
    return;
  }

  try {
    fs.writeFileSync(MARKETPLACE_JSON, JSON.stringify(data, null, 2) + '\n');
    console.log(`OK    LSP fix — patched ${changed} command(s) with .cmd extension`);
  } catch (err) {
    console.log(`WARN  LSP fix — could not write marketplace.json: ${err.message}`);
  }
}

function patchObject(obj, patches, onPatch) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) patchObject(item, patches, onPatch);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key === 'command' && typeof obj[key] === 'string' && patches[obj[key]]) {
      obj[key] = patches[obj[key]];
      onPatch();
    } else {
      patchObject(obj[key], patches, onPatch);
    }
  }
}

// Allow running directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file:///', '').replace(/\//g, path.sep))) {
  fixLspWindows();
}
