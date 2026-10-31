// scripts/shared/credential-key.mjs — fetch a host session's API key from the git credential store.
//
// The key lives in the store ONLY (ai-lab's `python -m ai_lab.auth login`); a launcher reads it at
// launch with `git credential fill` (the primitive lab_commons.credentials uses; no Python) and
// puts it in the projected env var of the child it spawns. It is never written to a file and
// never logged: a message names the host, the username and at most a sha256 fingerprint.
//
// The username is the catalogue's `key_usernames.session` (ai-lab derives it from lab-commons'
// one naming rule); Node never re-derives it.

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

export const SESSION_TASK = 'session';

/** A sha256 prefix that names a key without revealing it. */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/** The credential username a host session reads for `row`, or {error}. */
export function sessionUsername(name, row) {
  const username = row?.key_usernames?.[SESSION_TASK];
  if (username) return { username };
  return {
    error: `provider ${name} has no '${SESSION_TASK}' key username in the provider cache `
      + `(lab_commons API_KEY_TASKS must declare '${SESSION_TASK}'); update ai-lab, then rerun setup`,
  };
}

/**
 * `git credential fill` for https://<username>@<host>, prompts off.
 * @returns {{key: string} | {error: string}}
 */
export function fetchKey({ host, username = null, run = spawnSync }) {
  // No username: whatever the store holds for the host (a forge token stored with `git credential approve`).
  const input = `protocol=https\nhost=${host}\n${username ? `username=${username}\n` : ''}\n`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  const res = run('git', ['credential', 'fill'], { input, encoding: 'utf8', env, windowsHide: true });
  if (res.error?.code === 'ENOENT') return { error: 'no git: `git credential fill` is how a launcher reads its key; install git' };
  if (res.error) return { error: `git credential fill failed: ${res.error.message}` };
  const password = res.status === 0 && /^password=(.*)$/m.exec(String(res.stdout))?.[1]?.replace(/\r$/, '');
  if (!password && !username) return { error: `no credential for ${host} in the git credential store` };
  if (!password) {
    return {
      error: `no key ${username}@${host} in the git credential store; `
        + `store one: python -m ai_lab.auth login <provider> --task ${SESSION_TASK}`,
    };
  }
  return { key: password, username: /^username=(.*)$/m.exec(String(res.stdout))?.[1]?.replace(/\r$/, '') ?? username };
}
