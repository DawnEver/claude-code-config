import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hooksDrift, applyTemplateHooks } from './settings-hooks.mjs';
import { checkPayloadShape } from './doctor.js';
import { tempDir } from '../shared/temp-dir.mjs';

const NEW = { SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/claude-hook.mjs --event SessionStart', timeout: 30 }] }] };
const OLD = { SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/sync-hook.js --pull', timeout: 90 }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/bridge-hook.js' }] }] };

function fixture(live) {
  const dir = tempDir('settings-hooks-');
  const settingsPath = path.join(dir, 'claude_settings.json');
  const templatePath = path.join(dir, 'claude_settings.template.json');
  fs.writeFileSync(settingsPath, JSON.stringify(live, null, 4) + '\n');
  fs.writeFileSync(templatePath, JSON.stringify({ env: {}, hooks: NEW }, null, 4));
  return { dir, settingsPath, templatePath };
}

test('hooksDrift names each event whose wiring differs; key order is not drift', () => {
  assert.deepEqual(hooksDrift({ hooks: OLD }, { hooks: NEW }), ['PostToolUse', 'SessionStart']);
  const reordered = { SessionStart: [{ hooks: [{ timeout: 30, command: NEW.SessionStart[0].hooks[0].command, type: 'command' }] }] };
  assert.deepEqual(hooksDrift({ hooks: reordered }, { hooks: NEW }), []);
  assert.deepEqual(hooksDrift({}, {}), []);
});

test('applyTemplateHooks: the template hooks land, every personal key stays, the hard link survives', () => {
  const f = fixture({ env: { MINE: '1' }, model: 'opus', hooks: OLD });
  const mirror = path.join(f.dir, 'mirror.json');
  fs.linkSync(f.settingsPath, mirror);   // as setup hard-links the payload into ~/.claude without symlink rights
  try {
    assert.deepEqual(applyTemplateHooks(f), { changed: true, events: ['PostToolUse', 'SessionStart'] });
    const live = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'));
    assert.deepEqual(live, { env: { MINE: '1' }, model: 'opus', hooks: NEW });
    assert.equal(fs.readFileSync(mirror, 'utf8'), fs.readFileSync(f.settingsPath, 'utf8'), 'written in place: the linked name sees it');
    assert.equal(fs.statSync(f.settingsPath).nlink, 2, 'still one file record');
    assert.match(fs.readFileSync(f.settingsPath, 'utf8'), /^\{\n {4}"env"[\s\S]*\}\n$/, 'its 4-space shape and final newline');
    const before = fs.statSync(f.settingsPath).mtimeMs;
    assert.deepEqual(applyTemplateHooks(f), { changed: false, events: [] }, 'idempotent');
    assert.equal(fs.statSync(f.settingsPath).mtimeMs, before, 'an in-sync payload is not rewritten');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('doctor: a payload whose hooks differ from the template is a FAIL naming the door; an equal one is not', () => {
  const f = fixture({ env: {}, hooks: OLD });
  try {
    const [drift] = checkPayloadShape(f.dir, f.dir, ['claude_settings.json']);
    assert.equal(drift?.id, 'payload-hooks-drift');
    assert.equal(drift.level, 'FAIL');
    assert.match(drift.detail, /settings-hooks\.mjs --apply/);
    applyTemplateHooks(f);
    assert.deepEqual(checkPayloadShape(f.dir, f.dir, ['claude_settings.json']), []);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
