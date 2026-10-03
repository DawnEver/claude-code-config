// scripts/bridge/extra-resets.mjs — announced extra resets for Codex and Claude, as fleet
// report STATE (docs/bridge.md "Fleet report"). Not the rolling 5h/weekly windows: the
// one-off resets vendor staff announce, tracked by community sites with public JSON APIs
// (not official):
//   Codex  codex-resets.com/api/v1/{resets,status}
//   Claude clauderesets.com/api/v1/{resets,status}
// Each report shows, per host, the latest applied extra reset, an announced-but-not-applied
// one, and any banked reset still to claim. The hourly round is the notification: no
// separate message, no cross-machine coordination, nothing lost when a machine is off.

const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const newest = (list) => list.filter((e) => e.at).sort((a, b) => b.at - a.at)[0] ?? null;

/**
 * One host's state: {applied, scheduled, banked: []}; an event is {at, scope, expires, url}.
 * codex-resets.com: resets {reset_type: regular|banked, announced_at, source.url};
 * status.scheduled_reset. Codex banked events state no expiry: the account's own reset
 * credits (codex-adapter) are what can be spent.
 */
export function codexState(resets, status) {
  const list = (Array.isArray(resets) ? resets : []).map((e) => ({ type: e?.reset_type, at: ms(e?.announced_at), url: e?.source?.url ?? null }));
  const s = status?.scheduled_reset;
  return {
    applied: newest(list.filter((e) => e.type !== 'banked')),
    scheduled: s ? { at: ms(s.scheduled_at ?? s.announced_at), url: s.source?.url ?? null } : null,
    banked: [],
  };
}

/**
 * clauderesets.com: resets {kind: usage_reset, event_status, announced_at|announced_on,
 * audience.statement, url}; status.reset_offers {kind: credit, reset_offer.expires_on};
 * status.announced_reset = announced, not applied yet. Confirmed events only.
 */
export function claudeState(resets, status, now) {
  // `id` lets a seat mark a banked reset it has claimed; `name` is the title's lead
  // ("Opus 5.5: a reset you can save for later" -> "Opus 5.5").
  const one = (e) => ({ id: e.id, name: String(e.title ?? '').split(':')[0].trim() || null,
    at: ms(e.announced_at ?? e.announced_on), scope: e.audience?.statement ?? null,
    expires: ms(e.reset_offer?.expires_on), url: e.url ?? null });
  const confirmed = (l) => (Array.isArray(l) ? l : []).filter((e) => e?.event_status === 'confirmed');
  const a = status?.announced_reset;
  return {
    applied: newest(confirmed(resets).filter((e) => e.kind !== 'credit').map(one)),
    scheduled: a ? one(a) : null,
    banked: confirmed(status?.reset_offers).filter((e) => e.kind === 'credit').map(one)
      .filter((e) => !e.expires || e.expires > now).sort((x, y) => (x.expires ?? Infinity) - (y.expires ?? Infinity)),
  };
}

const SOURCES = [
  ['Codex', 'https://codex-resets.com/api/v1', codexState],
  ['Claude', 'https://clauderesets.com/api/v1', claudeState],
];

/** {Codex: state|null, Claude: state|null}; a failing source is logged and reads as null. */
export async function fetchExtraResets({ fetch = globalThis.fetch, now = Date.now(), timeoutMs = 10000, log = () => {} } = {}) {
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json())?.data;
  };
  const out = {};
  await Promise.all(SOURCES.map(async ([host, base, state]) => {
    try { out[host] = state(...await Promise.all([get(`${base}/resets`), get(`${base}/status`)]), now); }
    catch (e) { out[host] = null; log(`extra resets ${host}: ${e.message}`); }
  }));
  return out;
}
