// The family principles page is a RENDER of dev_lab.dev.principles (the one source), never hand-edited, and
// GLOBAL-AGENTS.md (~/.claude/CLAUDE.md) carries the page's bullets verbatim between its principles markers.
// Re-render: python -c "import pathlib; from dev_lab.dev.principles import write_page; write_page(pathlib.Path('.'))"
// The drift check needs a Python that imports dev_lab (DEV_LAB_PYTHON, else `python`); without one it skips, saying so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const page = read('.claude/rules/principles.md');

test('the committed principles page equals dev_lab.dev.principles.render()', (t) => {
  assert.match(page, /^# Principles -- family policy, rendered from dev_lab\.dev\.principles; edit there\n/);
  const run = spawnSync(process.env.DEV_LAB_PYTHON || 'python',
    ['-c', 'import sys; from dev_lab.dev.principles import render; sys.stdout.write(render())'],
    { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) return t.skip('no Python importing dev_lab: set DEV_LAB_PYTHON to check drift');
  assert.equal(page, run.stdout.replace(/\r\n/g, '\n'), 'principles.md drifted from dev_lab.dev.principles; re-render it');
});

test('GLOBAL-AGENTS.md carries the page bullets verbatim between its principles markers', () => {
  const block = read('GLOBAL-AGENTS.md').match(/<!-- principles:begin[^>]*-->\n([\s\S]*?)<!-- principles:end -->/);
  assert.ok(block, 'GLOBAL-AGENTS.md holds no principles:begin/end block');
  assert.equal(block[1], page.slice(page.indexOf('- **')), 'copy the bullets of .claude/rules/principles.md');
});
