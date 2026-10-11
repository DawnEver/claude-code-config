// scripts/bridge/extra-resets.mjs — announced extra resets for Codex and Claude, as fleet
// report STATE (docs/bridge.md "Fleet report"). Not the rolling 5h/weekly windows: the
// one-off resets vendor staff announce, tracked by community sites with public JSON APIs
// (not official):
//   Codex  codex-resets.com/api/v1/{resets,status}
//   Claude clauderesets.com/api/v1/{resets,status}
// Each report shows, per host, the latest applied extra reset, an announced-but-not-applied
// one. Whether an account holds a reset to spend is account state, not an announcement:
// Codex reads it from the account (codex-adapter reset credits); Claude exposes none.
// The hourly round is the notification: no separate message, no cross-machine
// coordination, nothing lost when a machine is off.

const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const newest = (list) => list.filter((e) => e.at).sort((a, b) => b.at - a.at)[0] ?? null;

/**
 * One host's state: {applied, scheduled}; an event is {at, scope, url}.
 * codex-resets.com: resets {reset_type: regular|banked, announced_at, source.url};
 * status.scheduled_reset. Banked events are not applied resets.
 */
export function codexState(resets, status) {
  const list = (Array.isArray(resets) ? resets : []).map((e) => ({ type: e?.reset_type, at: ms(e?.announced_at), url: e?.source?.url ?? null }));
  const s = status?.scheduled_reset;
  return {
    applied: newest(list.filter((e) => e.type !== 'banked')),
    scheduled: s ? { at: ms(s.scheduled_at ?? s.announced_at), url: s.source?.url ?? null } : null,
  };
}

/**
 * clauderesets.com: resets {kind: usage_reset, event_status, announced_at|announced_on,
 * audience.statement, url}; status.announced_reset = announced, not applied yet. Confirmed events only.
 */
export function claudeState(resets, status) {
  const one = (e) => ({ at: ms(e.announced_at ?? e.announced_on), scope: e.audience?.statement ?? null, url: e.url ?? null });
  const confirmed = (l) => (Array.isArray(l) ? l : []).filter((e) => e?.event_status === 'confirmed');
  const a = status?.announced_reset;
  return {
    applied: newest(confirmed(resets).filter((e) => e.kind !== 'credit').map(one)),
    scheduled: a ? one(a) : null,
  };
}

const SOURCES = [
  ['Codex', 'https://codex-resets.com/api/v1', codexState],
  ['Claude', 'https://clauderesets.com/api/v1', claudeState],
];

/** {Codex: state|null, Claude: state|null}; a failing source is logged and reads as null. */
export async function fetchExtraResets({ fetch = globalThis.fetch, timeoutMs = 10000, log = () => {} } = {}) {
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json())?.data;
  };
  const out = {};
  await Promise.all(SOURCES.map(async ([host, base, state]) => {
    try { out[host] = state(...await Promise.all([get(`${base}/resets`), get(`${base}/status`)])); }
    catch (e) { out[host] = null; log(`extra resets ${host}: ${e.message}`); }
  }));
  return out;
}
