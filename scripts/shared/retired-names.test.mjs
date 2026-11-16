// Retired names: a name that no longer says what its thing does is renamed, and the old one is
// registered here so it cannot come back. Memory under .claude/memory is history and may keep it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'scripts/shared/retired-names.test.mjs';

/** retired name -> what replaced it (2026-11-16: the bridge board is not the rem task system). */
export const RETIRED = {
  'tasks.mjs': 'scripts/bridge/activity-board.mjs',
  TaskBoard: 'ActivityBoard',
};

const uses = (name) => {
  try {
    return execFileSync('git', ['grep', '-l', '-F', name, '--', '.', ':!.claude/memory', `:!${SELF}`],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (err) { if (err.status === 1) return []; throw err; }
};

for (const [name, now] of Object.entries(RETIRED)) {
  test(`retired name ${name} is used nowhere (now: ${now})`, () => {
    assert.deepEqual(uses(name), [], `${name} is retired; use ${now}`);
  });
}

test('the scan can say no: a registered name that IS used is found', () => {
  assert.ok(uses('ActivityBoard').length > 0, 'the current name is found, so a retired one would be');
});
