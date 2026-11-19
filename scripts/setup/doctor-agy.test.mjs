import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAgyConfig, checkRuleFileSize } from './doctor.js';
import { installAgyConfig } from './agy-config.mjs';

test('checkAgyConfig: silent without agy, FAIL on missing hook or legacy session-bridge MCP, WARN until a hook ran', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agyHome = path.join(home, '.gemini', 'config');
  const scriptsDir = path.join(home, '.claude', 'scripts');
  const marketDir = path.join(home, 'family', 'cc-market');
  assert.deepEqual(checkAgyConfig({ agyHome, scriptsDir, marketDir }), []);
  fs.mkdirSync(agyHome, { recursive: true });
  fs.writeFileSync(path.join(agyHome, 'mcp_config.json'), JSON.stringify({
    mcpServers: { 'session-bridge': { command: 'node', args: ['C:/repo/claude_plugins/session-bridge/server.mjs'] } },
  }));
  const ids = checkAgyConfig({ agyHome, scriptsDir, marketDir }).map(f => f.id);
  assert.ok(ids.includes('agy-native-hooks') && ids.includes('agy-mcp'));
  installAgyConfig({ agyDir: agyHome, scriptsDir, marketDir, smoke: () => ({ ok: true }) });
  assert.deepEqual(checkAgyConfig({ agyHome, scriptsDir, marketDir }).map(f => f.level), ['WARN']);
});

test('checkRuleFileSize: passes under 24,000 bytes and FAILs when AGENTS.md or GLOBAL-AGENTS.md exceeds it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rulesize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'short\n');
  fs.writeFileSync(path.join(root, 'GLOBAL-AGENTS.md'), 'short\n');
  assert.deepEqual(checkRuleFileSize(root), []);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(24001));
  const f = checkRuleFileSize(root);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'rule-file-size');
  assert.equal(f[0].level, 'FAIL');
});
