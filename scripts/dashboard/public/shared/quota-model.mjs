// scripts/dashboard/public/shared/quota-model.mjs — the quota domain, on the reader's clock:
// what an account's windows mean now (quotaView), which conditions are alerts (alertKey,
// quotaAlertsFor). Data only, no text: the Worker judges alerts with it and stores the events
// as data; the page reads accounts with it and words the events (view.mjs eventText).

import { QUOTA_STALE_MS } from './vocab.mjs';

/**
 * One account as read at `now`: each window's use, the even-spend pace by now, and the forecast
 * (none from a stale reading); then the binding window — the one that runs out soonest, else the
 * fullest — and its verdict. A passed reset is a new window not yet read.
 */
export function quotaView(a, now = Date.now()) {
  const stale = !a.at || now - a.at > QUOTA_STALE_MS;
  const windows = a.windows.map((w) => {
    const renewed = !w.resetsAt || w.resetsAt <= now;
    return { k: w.k, renewed, used: renewed ? 0 : w.used, resetsAt: renewed ? null : w.resetsAt, windowMs: w.windowMs,
      pace: renewed ? 0 : Math.min(100, Math.max(0, (1 - (w.resetsAt - now) / w.windowMs) * 100)),
      cells: renewed ? [] : w.cells, forecast: renewed || stale ? null : w.forecast };
  });
  const live = windows.filter((w) => !w.renewed);
  const bind = live.filter((w) => w.forecast?.short).sort((x, y) => x.forecast.eta - y.forecast.eta)[0]
    ?? [...live].sort((x, y) => y.used - x.used)[0] ?? null;
  const verdict = !bind ? 'none' : bind.used >= 100 ? 'exhausted' : bind.forecast?.short ? 'short' : 'ok';
  return { ...a, stale, windows, bind, verdict, left: bind ? Math.round(100 - bind.used) : null };
}

/** One alert's identity: the account, its verdict and the window period. A new period is a new alert. */
export const alertKey = (q) => JSON.stringify([q.key, q.verdict, q.bind?.k ?? null, q.bind?.resetsAt ?? null]);

/** Who an event is about: enough to name the account, nothing more. */
const who = (q) => ({ agent: q.agent, label: q.label ?? null, email: q.email ?? null });

/**
 * The events a change of `q` (a quotaView) warrants against what was last alerted for its
 * account (`prev`): a window turning exhausted (a forecast run-out is shown, never alerted), a new
 * seat problem, a newly announced extra reset. Returns the events, as data, and the state to
 * remember. An unchanged condition alerts once; recovering clears it, so a relapse alerts again.
 */
export function quotaAlertsFor(prev, q) {
  const events = [];
  if (q.verdict === 'exhausted' && prev?.verdict !== 'exhausted') events.push({ kind: 'exhausted', account: who(q), window: q.bind.k, resetsAt: q.bind.resetsAt });
  for (const p of q.problems) if (!prev?.problems?.includes(p)) events.push({ kind: 'seat-problem', account: who(q), problem: p });
  const extraAt = q.extraReset ? q.extraReset.at ?? 0 : null;
  if (extraAt !== null && prev?.extraAt !== extraAt) events.push({ kind: 'extra-reset', account: who(q), at: q.extraReset.at ?? null, url: q.extraReset.url ?? null });
  return { events, state: { verdict: q.verdict, problems: [...q.problems], extraAt } };
}
