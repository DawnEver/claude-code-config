// The public settings template is GENERIC: a person's or a project's toolchain facts live in
// the personal payload or in a repo's own .claude/automode.json (scripts/runtime/repo-automode.mjs),
// never here. Each check runs on a planted control first, so a check that matches nothing fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const template = JSON.parse(readFileSync(join(fileURLToPath(new URL('../..', import.meta.url)), 'claude_settings.template.json'), 'utf8'));

// Host names, org URLs, module/command spellings and paths that name one person's or project's setup.
const SPECIFIC = [
  /\b[a-z0-9-]+(\.[a-z0-9-]+)+\.(com|org|net|io|site|dev|ac\.uk|edu)\b/i,
  /https?:\/\//i,
  /\bpython\d?\s+-m\b/i,
  /\blab[_-]commons\b/i,
  /\bdev[_-]lab\b/i,
  /(^|[\s(])(~|\/|[A-Z]:[\\/])[\w.-]*[\\/]/,
];

/** Every string in the template's autoMode and permissions rows. */
function rows(settings) {
  const auto = Object.values(settings.autoMode ?? {}).filter(Array.isArray).flat();
  const perms = ['allow', 'deny', 'ask'].flatMap((k) => settings.permissions?.[k] ?? []);
  return [...auto, ...perms].filter((r) => typeof r === 'string');
}

const specificRows = (settings) => rows(settings).filter((r) => SPECIFIC.some((re) => re.test(r)));

test('planted control: every specific spelling is caught', () => {
  const planted = {
    autoMode: { allow: ['$defaults', 'Pushing to git.example.com/team', 'Running `python -m lab_commons.dev.forge`'],
      environment: ['dev_lab checkouts', 'Repos under https://forge.example/org'] },
    permissions: { allow: ['Bash(/opt/tool/run *)', 'Bash(~/bin/x)'] },
  };
  assert.equal(specificRows(planted).length, 6);
});

test('template autoMode and permissions name no host, org, module, command or path', () => {
  assert.deepEqual(specificRows(template), []);
});

const missingDefaults = (settings) => Object.entries(settings.autoMode ?? {})
  .filter(([, v]) => Array.isArray(v) && !v.includes('$defaults')).map(([k]) => k);

test('planted control: an autoMode array without "$defaults" is caught', () => {
  assert.deepEqual(missingDefaults({ autoMode: { allow: ['$defaults'], soft_deny: ['x'] } }), ['soft_deny']);
});

test('every template autoMode array keeps the built-in rules', () => {
  assert.deepEqual(missingDefaults(template), []);
});
