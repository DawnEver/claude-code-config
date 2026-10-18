// scripts/shared/fleet-schema.mjs — the fleet wire format, the single definition shared by
// the host push (scripts/bridge/fleet-push.mjs) and the gateway. `parseHostPush` is the trust
// boundary: it whitelists fields, bounds sizes and drops anything malformed, so nothing a
// host sends reaches the Mini App unchecked.

import { isValidMachineName } from './machine.mjs';

export const SCHEMA_VERSION = 1;
export const AGENTS = ['claude', 'codex'];
/** Native session status (scripts/bridge/daemon.mjs STATUS_CODES). Freshness (`stale`) is separate, set by the gateway. */
export const STATUSES = ['working', 'idle', 'needs_approval', 'needs_input', 'ended', 'unknown'];
export const MAX_SESSIONS = 200;
/** A host id is its machine name (scripts/shared/machine.mjs), bounded for the gateway. */
export const isHostId = (id) => isValidMachineName(id) && id.length <= 64;

const text = (v, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A Telegram link only for a private supergroup Topic (`-100<id>`), the only kind the bridge uses. */
export function topicUrl(chatId, topicId) {
  const m = /^-100(\d{1,15})$/.exec(String(chatId));
  return m && Number.isSafeInteger(topicId) && topicId > 0 ? `https://t.me/c/${m[1]}/${topicId}` : null;
}

function parseSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = text(s.id, 128);
  if (!id || !AGENTS.includes(s.agent)) return null;
  const at = Date.parse(s.lastActivityAt);
  const t = s.topic;
  const url = t && topicUrl(t.chatId, t.topicId);
  return {
    id, agent: s.agent, project: text(s.project), branch: text(s.branch, 200), seat: text(s.seat, 64),
    status: STATUSES.includes(s.status) ? s.status : 'unknown',
    lastActivityAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    topic: url ? { url, closed: t.closed === true } : null,
  };
}

/** A host's POST body -> {bootAt, seq, sessions} or null. Unknown session entries are dropped, not fatal. */
export function parseHostPush(body) {
  if (!body || body.schemaVersion !== SCHEMA_VERSION || !Array.isArray(body.sessions)) return null;
  if (!Number.isSafeInteger(body.bootAt) || body.bootAt < 1 || !Number.isSafeInteger(body.seq) || body.seq < 1) return null;
  const seen = new Set();
  const sessions = [];
  for (const raw of body.sessions.slice(0, MAX_SESSIONS)) {
    const s = parseSession(raw);
    if (s && !seen.has(`${s.agent}:${s.id}`)) { seen.add(`${s.agent}:${s.id}`); sessions.push(s); }
  }
  return { bootAt: body.bootAt, seq: body.seq, sessions };
}
