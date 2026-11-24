// RETIRED PLUGINS (user ruling 2026-11-24): cc-market keeps only cc-academia. A retired plugin is never
// enabled by any template this repo renders, so a re-render keeps it uninstalled. Each check runs on a
// planted control first, so a check that matches nothing fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_PLUGINS } from './retired-plugins.mjs';
import { AGY_PLUGINS } from './agy-config.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const claudeTemplate = JSON.parse(readFileSync(join(root, 'claude_settings.template.json'), 'utf8'));
const codexTemplate = readFileSync(join(root, 'codex_config.template.toml'), 'utf8');

const enabledInClaude = (settings) => RETIRED_PLUGINS.filter((p) => settings.enabledPlugins?.[`${p}@cc-market`] === true);
const namedInCodex = (toml) => RETIRED_PLUGINS.filter((p) => toml.includes(`[plugins."${p}@cc-market"]`));
const loadedByAgy = (plugins) => RETIRED_PLUGINS.filter((p) => [...plugins.enabled, ...plugins.dormant].includes(p));

test('the retired set is the 2026-11-24 ruling', () => {
  assert.deepEqual([...RETIRED_PLUGINS].sort(), ['cc-latex', 'evolve', 'fabric', 'rem', 'sharp-review', 'traceme', 'watch']);
});

test('planted control: a retired plugin enabled in any template is caught', () => {
  assert.deepEqual(enabledInClaude({ enabledPlugins: { 'rem@cc-market': true, 'cc-academia@cc-market': true } }), ['rem']);
  assert.deepEqual(namedInCodex('[plugins."fabric@cc-market"]\nenabled = true\n'), ['fabric']);
  assert.deepEqual(loadedByAgy({ enabled: ['evolve'], dormant: ['watch', 'cc-academia'] }), ['evolve', 'watch']);
});

test('no template enables a retired plugin', () => {
  assert.deepEqual(enabledInClaude(claudeTemplate), []);
  assert.deepEqual(namedInCodex(codexTemplate), []);
  assert.deepEqual(loadedByAgy(AGY_PLUGINS), []);
});
