// GLOBAL-AGENTS.md (~/.claude/CLAUDE.md on every host) carries the family principles between its principles markers,
// RENDERED from dev_lab.dev.principles by scripts/shared/principles.mjs, never hand-edited. The source is read under
// this checkout's own interpreter (own-python.mjs); an environment that cannot provide it FAILS naming its door --
// there is no skip, because a checkout without its .venv is unbuilt, not Python-less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEGIN, END, GLOBAL_REL, RENDER_DOOR, familyBullets, renderGlobal, spliceBlock } from './principles.mjs';
import { OWN_ROOT } from './own-python.mjs';
import { tempDir } from './temp-dir.mjs';

const lf = (s) => s.replace(/\r\n/g, '\n');
const BULLETS = '- **A** (`a`): one.\n- **B** (`b`): two.\n';
const page = (body) => `# Global\n\n## Principles\n\n${BEGIN}\n${body}${END}\n- **Local.** kept.\n`;

test('the committed GLOBAL-AGENTS.md block is the render of dev_lab.dev.principles', () => {
  const text = lf(readFileSync(join(OWN_ROOT, GLOBAL_REL), 'utf8'));
  assert.equal(text, spliceBlock(text, familyBullets()), `${GLOBAL_REL} drifted from dev_lab.dev.principles; re-render: ${RENDER_DOOR}`);
});

test('splicing replaces only the block, marker included, and keeps the text around it', () => {
  const stale = page('- **Old** (`old`): gone.\n').replace(BEGIN, '<!-- principles:begin -- an older marker -->');
  assert.equal(spliceBlock(stale, BULLETS), page(BULLETS));
  assert.equal(spliceBlock(page(BULLETS), BULLETS), page(BULLETS), 'a current block is a fixed point');
});

test('a text without the block is refused by name', () => {
  assert.throws(() => spliceBlock('# Global\n', BULLETS), /holds no principles:begin\/end block/);
});

test('a missing interpreter FAILS naming the environment door, never skips', () => {
  assert.throws(() => familyBullets({ python: join(tempDir('principles-'), 'no-python.exe') }),
    (err) => /no interpreter at .*no-python\.exe/.test(err.message) && err.message.includes('uv sync --all-groups'));
});

test('an interpreter that cannot render the principles FAILS naming dev-lab and its door', () => {
  const run = () => ({ status: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'dev_lab'\n" });
  assert.throws(() => familyBullets({ python: 'py', run }),
    (err) => err.message.includes("No module named 'dev_lab'") && err.message.includes('uv sync --all-groups'));
});

test('the bullets end in exactly one newline, whatever the console wrote', () => {
  const run = () => ({ status: 0, stdout: '- **A** (`a`): one.\r\n- **B** (`b`): two.\r\n\r\n', stderr: '' });
  assert.equal(familyBullets({ python: 'py', run }), BULLETS);
});

test('the render door rewrites the block in place, LF', () => {
  const root = tempDir('principles-');
  writeFileSync(join(root, GLOBAL_REL), page('- **Old** (`old`): gone.\n').replace(/\n/g, '\r\n'));
  renderGlobal({ root, bullets: BULLETS });
  assert.equal(readFileSync(join(root, GLOBAL_REL), 'utf8'), page(BULLETS));
});
