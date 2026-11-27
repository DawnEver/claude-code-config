import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveLocal } from './local-serve.mjs';

const read = () => ({ cache: { providers: { llamacpp: { url: 'http://127.0.0.1:8080' } } } });

test('a served provider reports the running server context window', async () => {
  let asked;
  const out = await serveLocal('llamacpp', { run: (a) => { asked = a; return { status: 0 }; }, read,
    fetchJson: async (url) => (url === 'http://127.0.0.1:8080/props' ? { default_generation_settings: { n_ctx: 196608 } } : null) });
  assert.deepEqual(asked, ['-m', 'ai_lab.serve', 'ensure', 'llamacpp']);
  assert.deepEqual(out, { error: null, contextWindow: 196608 });
});

test('a failed ensure refuses the launch; an unreadable /props only drops the window', async () => {
  assert.match((await serveLocal('llamacpp', { run: () => ({ status: 1 }), read })).error, /ensure llamacpp failed/);
  const out = await serveLocal('llamacpp', { run: () => ({ status: 0 }), read, fetchJson: async () => { throw new Error('down'); } });
  assert.deepEqual(out, { error: null, contextWindow: null });
});
