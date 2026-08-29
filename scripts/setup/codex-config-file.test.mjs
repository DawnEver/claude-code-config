import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeFileAtomic,
  localSectionsForThisHost,
  composeCodexConfigFile,
} from './codex-config-file.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `codex-cfg-${p}-`));

const ENV_SETTINGS = JSON.stringify({
  providers: {
    deepseek: { url: 'https://api.deepseek.com', codexPath: '/v1', codexApiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
});

function fixture({ payload, existingCodexConfig, codexIsSymlink = false } = {}) {
  const syncDir = tmp('sync');
  const codexDir = tmp('codex');
  fs.writeFileSync(path.join(syncDir, 'codex_config.toml'), payload ?? 'model = "x"\n');
  const envSettingsPath = path.join(syncDir, 'claude_env_settings.json');
  fs.writeFileSync(envSettingsPath, ENV_SETTINGS);

  if (existingCodexConfig !== undefined) {
    const target = path.join(codexDir, 'config.toml');
    if (codexIsSymlink) {
      const shared = path.join(syncDir, 'old-shared.toml');
      fs.writeFileSync(shared, existingCodexConfig);
      fs.symlinkSync(shared, target);
    } else {
      fs.writeFileSync(target, existingCodexConfig);
    }
  }
  return { syncDir, codexDir, envSettingsPath };
}

test('writeFileAtomic leaves no temp file behind and replaces the target', () => {
  const dir = tmp('atomic');
  const target = path.join(dir, 'f.toml');
  fs.writeFileSync(target, 'old');
  writeFileAtomic(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['f.toml']);
});

test('localSectionsForThisHost keeps project entries that exist here, drops the rest', () => {
  const real = tmp('real');
  const src = `[projects.'${real}']\ntrust_level = "trusted"\n\n`
    + `[projects.'/definitely/not/here/xyz']\ntrust_level = "trusted"\n\n`
    + `[notice]\nseen = true\n`;

  const r = localSectionsForThisHost(src);
  assert.equal(r.kept, 2, 'the existing project + [notice]');
  assert.equal(r.dropped, 1);
  assert.match(r.text, /notice/);
  assert.doesNotMatch(r.text, /definitely/);
});

test('composeCodexConfigFile strips machine state from the payload and backs it up first', () => {
  const payload = `model = "x"\n\n[tui]\na = 1\n\n[projects.'/tmp/whatever']\ntrust_level = "trusted"\n`;
  const { syncDir, codexDir, envSettingsPath } = fixture({ payload });

  const r = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(r.status, 'written');
  assert.equal(r.strippedFromPayload, 1);

  const payloadNow = fs.readFileSync(path.join(syncDir, 'codex_config.toml'), 'utf8');
  assert.doesNotMatch(payloadNow, /projects/);
  assert.match(payloadNow, /\[tui\]/);

  // Discarding content from a cloud-synced file must leave a recoverable copy.
  const bak = path.join(syncDir, 'codex_config.toml.pre-split-bak');
  assert.ok(fs.existsSync(bak));
  assert.match(fs.readFileSync(bak, 'utf8'), /projects/);
});

test('a symlinked pre-split config keeps THIS host\'s trust entries, not the whole fleet\'s', () => {
  // The first-upgrade case: ~/.codex/config.toml is still a symlink into the shared tree,
  // whose [projects.*] list spans every machine. Previously all of it was discarded.
  const here = tmp('here');
  const fleet = `[projects.'${here}']\ntrust_level = "trusted"\n\n`
    + `[projects.'c:\\users\\someoneelse\\proj']\ntrust_level = "trusted"\n`;
  const { syncDir, codexDir, envSettingsPath } = fixture({
    existingCodexConfig: fleet,
    codexIsSymlink: true,
  });

  const r = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(r.importedFromFleet, 1);
  assert.equal(r.droppedDeadPaths, 1);

  const target = path.join(codexDir, 'config.toml');
  assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'must become a real file');
  const out = fs.readFileSync(target, 'utf8');
  assert.ok(out.includes(here), 'this host\'s trusted path survives');
  assert.doesNotMatch(out, /someoneelse/);
});

test('composeCodexConfigFile is idempotent and reports no change on a second run', () => {
  const { syncDir, codexDir, envSettingsPath } = fixture({ payload: 'model = "x"\n\n[tui]\na = 1\n' });

  const first = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(first.changed, true);
  const afterFirst = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');

  const second = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(second.changed, false, 'a no-op run must not rewrite a file Codex may be reading');
  assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), afterFirst);
});

test('the generated provider block lands between the markers', () => {
  const { syncDir, codexDir, envSettingsPath } = fixture();
  const r = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(r.providers, 1);
  const out = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(out, /setup-managed[\s\S]*\[model_providers\.deepseek\][\s\S]*setup-managed/);
});

test('an unparseable payload is REFUSED, not rewritten', () => {
  // A multi-line string containing a header-looking line: splitting it would emit
  // unterminated TOML over the cloud payload.
  const payload = 'notes = """\n[projects.evil]\n';   // deliberately unbalanced
  const { syncDir, codexDir, envSettingsPath } = fixture({ payload });

  const r = composeCodexConfigFile({ syncDir, envSettingsPath, codexDir });
  assert.equal(r.status, 'unsafe');
  assert.equal(fs.readFileSync(path.join(syncDir, 'codex_config.toml'), 'utf8'), payload,
    'the payload must be left byte-identical');
});

test('a missing payload yields no-head rather than throwing', () => {
  const syncDir = tmp('empty');
  const codexDir = tmp('codex');
  const r = composeCodexConfigFile({
    syncDir,
    envSettingsPath: path.join(syncDir, 'claude_env_settings.json'),
    codexDir,
  });
  assert.equal(r.status, 'no-head');
});
