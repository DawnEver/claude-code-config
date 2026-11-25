import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asksForCode, decide, finalMessage, readReceipts, PREFLIGHT_DOOR } from './code-ask-hook.js';
import { tempDir } from '../shared/temp-dir.mjs';

const template = JSON.parse(fs.readFileSync(new URL('../../claude_settings.template.json', import.meta.url), 'utf8'));
const ASK = 'Preflight is green. Please give me the TOTP code and I will open the wave.';

test('an ask for a one-time code is recognized; talk about a code is not (planted negatives)', () => {
  for (const ask of [ASK, 'Send the consent code when ready?', "What's your 6-digit code", 'I need your cluster code.']) {
    assert.equal(asksForCode(ask), true, ask);
  }
  for (const talk of ['The consent code was not consumed.', 'The code compiles and the tests pass.',
    'breakglass open failed before the TOTP code was sent.', '']) {
    assert.equal(asksForCode(talk), false, talk);
  }
});

test('an ask without a fresh receipt is blocked naming the preflight door; a fresh receipt lets it stop', () => {
  const payload = { last_assistant_message: ASK, cwd: '.' };
  const none = decide(payload, { receipts: () => ({ status: 1, said: '[consent] no fresh preflight receipt' }) });
  assert.equal(none.decision, 'block');
  assert.match(none.reason, /no fresh preflight receipt/);
  assert.ok(none.reason.includes(PREFLIGHT_DOOR));
  assert.equal(decide(payload, { receipts: () => ({ status: 0, said: 'fresh' }) }), null, 'the planted control');
  const old = decide(payload, { receipts: () => ({ status: 2, said: "invalid choice: 'receipts'" }) });
  assert.match(old.reason, /update dev-lab/);
});

test('a message that asks nothing never reads the receipts', () => {
  let read = 0;
  assert.equal(decide({ last_assistant_message: 'Done; PR opened.' }, { receipts: () => { read += 1; return { status: 1 }; } }), null);
  assert.equal(read, 0);
});

test('a checkout with no dev-lab door has nothing to preflight: the stop passes', () => {
  const bare = tempDir('code-ask-');
  try {
    assert.deepEqual(readReceipts(bare), { status: null, said: '' });
    assert.equal(decide({ last_assistant_message: ASK, cwd: bare }), null);
    fs.mkdirSync(path.join(bare, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.claude', 'hooks', 'py.js'), '');
    const calls = [];
    const got = readReceipts(bare, { run: (cmd, args) => { calls.push(args.slice(1)); return { status: 1, stdout: '', stderr: 'none' }; } });
    assert.deepEqual(calls, [['-m', 'dev_lab.ops.consent', 'receipts']]);
    assert.deepEqual(got, { status: 1, said: 'none' });
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});

test('the final message falls back to the transcript when the payload carries none', () => {
  const file = path.join(tempDir('code-ask-'), 'receipts.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ASK }] } })].join('\n'));
  try { assert.equal(finalMessage({ transcript_path: file }), ASK); } finally { fs.rmSync(file, { force: true }); }
});

test('the template wires the hook on Stop', () => {
  const commands = template.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(commands.includes('node ~/.claude/scripts/hooks/code-ask-hook.js'), commands.join(' | '));
});
