// scripts/shared/channel-declaration.mjs — this machine's session-channel declaration: which
// Telegram user IS this machine's user. Its one source is hosts-config hosts/<machine>.toml
// `[dev] channels`, read through dev-lab's door (never a second TOML reader, never a local copy).
// The channel server tags inbound messages with it; the bridge daemon and the dashboard derive
// their sender allowlist from it.

import { spawnSync } from 'child_process';
import { ownPython } from './own-python.mjs';

/** The session bridge's channel source, as the machine declaration names it. */
export const CHANNEL_SOURCE = 'session-bridge';
/** dev-lab's door onto the machine's channel declaration: prints {source: user id} ({} when undeclared). */
export const DECLARATION_DOOR = ['-m', 'dev_lab.dev.devhost', 'channels', '--json'];
/** Where a missing or wrong declaration is fixed. */
export const DECLARATION_FIX = `declare it in hosts-config hosts/<machine>.toml [dev] channels "${CHANNEL_SOURCE}" (read by python ${DECLARATION_DOOR.join(' ')})`;
/** The note for a leftover allowedUserIds key: no longer read, and where the fact lives now. */
export const STALE_ALLOWLIST_KEY = 'bridge.allowedUserIds is no longer read: declared in hosts-config hosts/<machine>.toml [dev] channels; remove this key from claude_env_settings.local.json';

/**
 * This machine's session-channel declaration, read once through dev-lab.
 * It runs under cc-config's own interpreter (own-python.mjs), whose lock carries dev-lab.
 * Fails closed: any failure is an empty declaration plus why, so every message is undeclared.
 * @returns {{channels: Record<string, string>, why: string | null}}
 */
export function readChannelDeclaration({ python = ownPython(), run = spawnSync } = {}) {
  const none = (why) => ({ channels: {}, why });
  const res = run(python, DECLARATION_DOOR, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (res.error) return none(`door failed: ${res.error.message} (build it: node scripts/setup/setup.js)`);
  if (res.status !== 0) return none(`door failed: ${String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { return none('door printed no JSON'); }
  const valid = doc && typeof doc === 'object' && !Array.isArray(doc)
    && Object.values(doc).every((v) => typeof v === 'string' && v);
  return valid ? { channels: doc, why: Object.keys(doc).length ? null : 'nothing declared' } : none('door printed no source -> user object');
}

/**
 * The Telegram senders the bridge and the dashboard accept: exactly the declared session-bridge
 * user. Fails closed: an unreadable or missing declaration is an empty list plus why (naming the
 * door to fix), never a fallback. `bridge` is the merged bridge settings block, read only to name
 * a leftover allowedUserIds key, whose value is never used.
 * @returns {{allowedUserIds: number[], why: string | null, stale: string | null}}
 */
export function declaredAllowlist({ declaration = readChannelDeclaration(), bridge = {} } = {}) {
  const stale = bridge && Object.hasOwn(bridge, 'allowedUserIds') ? STALE_ALLOWLIST_KEY : null;
  const id = declaration.channels?.[CHANNEL_SOURCE];
  const n = /^\d+$/.test(id ?? '') ? Number(id) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return { allowedUserIds: [n], why: null, stale };
  const why = declaration.why
    ?? (id === undefined ? `no "${CHANNEL_SOURCE}" channel declared` : `the declared "${CHANNEL_SOURCE}" user is not a Telegram user id`);
  return { allowedUserIds: [], why: `${why}; ${DECLARATION_FIX}`, stale };
}
