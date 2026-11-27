// scripts/shared/local-serve.mjs -- start a local provider's server before a session, and read its context.
//
// ai-lab owns how a local server starts (`python -m ai_lab.serve ensure <provider>`, from the user's
// serve.toml); the launchers (cc.js, codex.js) call it through cc-config's own interpreter. The context
// window is the RUNNING server's (`/props` n_ctx), the one fact a host needs to compact in time: never
// declared twice.

import { spawnSync } from 'child_process';
import { ownPython } from './own-python.mjs';
import { readProviderCache } from './provider-cache.mjs';

/**
 * Start *provider*'s server unless it answers; then its context window.
 * @returns {Promise<{error: string|null, contextWindow: number|null}>}
 */
export async function serveLocal(provider, {
  run = (args) => spawnSync(ownPython(), args, { stdio: 'inherit' }),
  read = readProviderCache,
  fetchJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json(),
} = {}) {
  const started = run(['-m', 'ai_lab.serve', 'ensure', provider]);
  if (started.status !== 0) return { error: `ai_lab.serve ensure ${provider} failed (exit ${started.status ?? 'none'})`, contextWindow: null };
  const got = read();
  const url = !got.error && got.cache?.providers?.[provider]?.url;
  if (!url) return { error: null, contextWindow: null };
  try {
    const n = (await fetchJson(`${url.replace(/\/$/, '')}/props`))?.default_generation_settings?.n_ctx;
    return { error: null, contextWindow: Number.isInteger(n) && n > 0 ? n : null };
  } catch {
    return { error: null, contextWindow: null };
  }
}
