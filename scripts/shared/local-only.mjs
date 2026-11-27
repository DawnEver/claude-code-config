// scripts/shared/local-only.mjs -- what keeps a session on this machine.
//
// A keyless local provider (ai-lab catalogue `auth = "local"`, e.g. llama.cpp) is local-only: its launchers
// (`ccla`, `codla`) set LOCAL_ONLY_ENV, and nothing that sends a session's content off the box mirrors it:
// the Claude bridge hook reads the env, the Codex bridge (app-server threads and rollout observer) reads
// the thread's provider against the catalogue.

import { readProviderCache } from './provider-cache.mjs';

export const LOCAL_ONLY_ENV = 'HARNESS_LOCAL_ONLY';

/** Whether *env* is a local-only session. */
export const isLocalOnly = (env = process.env) => env[LOCAL_ONLY_ENV] === '1';

/** Whether *provider* is a local-only provider in the catalogue; a broken cache makes none local. */
export function isLocalProvider(provider, read = readProviderCache) {
  if (!provider) return false;
  const got = read();
  return !got.error && got.cache?.providers?.[provider]?.auth === 'local';
}

/** A test for whether a model is served by a local-only provider (any role of a local row); read once. */
export function localModelTest(read = readProviderCache) {
  const got = read();
  const models = new Set(got.error ? [] : Object.values(got.cache?.providers ?? {})
    .filter((row) => row?.auth === 'local').flatMap((row) => Object.values(row.models ?? {})));
  return (model) => models.has(model);
}
