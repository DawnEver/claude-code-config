// `npm test`: run the node:test suite with TMP/TEMP/TMPDIR pointed at one fresh, empty directory, then refuse
// the run if anything is left in it. That is the full-suite proof that tests reclaim every temp entry they make
// (through `temp-dir.mjs`) -- including the ones made by the scripts they spawn, which inherit the env.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';

export const SUITE = [
  'skills/migrate/*.test.mjs', 'scripts/hooks/*.test.mjs', 'system-prompt/*.test.mjs', 'scripts/shared/*.test.mjs',
  'scripts/runtime/*.test.mjs', 'scripts/setup/*.test.mjs', 'scripts/bridge/*.test.mjs', 'scripts/dashboard/*.test.mjs',
  'scripts/usage/*.test.mjs', 'claude_plugins/session-bridge/*.test.mjs',
];

/** Run `node --test <files>` against a private temp root; return its exit status and what it left behind. */
export function runSuite(files, { base = tmpdir(), stdio = 'inherit', cwd = process.cwd() } = {}) {
  const root = mkdtempSync(join(base, 'cc-config-suite-'));
  // NODE_TEST_CONTEXT would make a nested `node --test` (this runner under test) report to its parent, not run.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env;
  const env = { ...inherited, TMP: root, TEMP: root, TMPDIR: root };
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio, env, cwd, encoding: 'utf8' });
  const left = readdirSync(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { status: run.status ?? 1, left, stdout: run.stdout ?? '' };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const { status, left } = runSuite(args.length ? args : SUITE);
  if (left.length) {
    console.error(`TEMP-LEAK: the run left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temp root: `
      + `${left.slice(0, 20).join(', ')}${left.length > 20 ? ', ...' : ''}.\n`
      + 'Make each temp directory with tempDir() from scripts/shared/temp-dir.mjs (it is removed at exit); '
      + 'a script under test that makes one must remove it itself.');
    process.exit(1);
  }
  process.exit(status);
}
