// scripts/bridge/quota-series.mjs — the quota observations of one account, kept for as long
// as the windows they describe are current, and where in each window the quota was spent.
//
// A sample is {from, at, windows: {<span>: {used, resetsAt, windowMs}}}: the values were first
// seen at `from` and last seen at `at`. An unchanged reading only moves `at`, so the file grows
// with change, not with time, and a rise between two samples is known to have happened between
// the last sight of the old value and the first sight of the new one. The last sample is the
// current quota (fleet.mjs reads nothing else). A sample whose every window has reset is
// history and is dropped on the next write: retention is the windows' own length.

import fs from 'fs';
import path from 'path';

// An unchanged reading refreshes `at` at most this often: freshness, not a heartbeat log.
const REFRESH_MS = 60000;
// Two readings of one window can disagree on its reset by a little; a new window moves it by hours.
const SAME_RESET_MS = 15 * 60000;
const H = 3600000;

const sameValues = (a, b) => JSON.stringify(Object.entries(a ?? {}).map(([k, w]) => [k, w.used, w.resetsAt]))
  === JSON.stringify(Object.entries(b ?? {}).map(([k, w]) => [k, w.used, w.resetsAt]));
const current = (sample, now) => Object.values(sample.windows ?? {}).some((w) => w.resetsAt > now);

/** Every sample in `file`, oldest first; unreadable lines are skipped. */
export function readSeries(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => {
    try { const s = JSON.parse(line); return s?.at > 0 && s.windows ? [s] : []; } catch { return []; }
  });
}

/**
 * Record `windows` observed at `now`. Returns true when the file was written. Fail-silent:
 * the callers (a status line, the daemon) must never break on it.
 */
export function recordSample(file, windows, now = Date.now()) {
  try {
    if (!windows || !Object.keys(windows).length) return false;
    const series = readSeries(file).filter((s) => s.at <= now && current(s, now));
    const last = series.at(-1);
    // A reading may carry only some windows; one it omits has not reset, so it keeps its value.
    const kept = Object.entries(last?.windows ?? {}).filter(([k, w]) => !windows[k] && w.resetsAt > now);
    windows = { ...Object.fromEntries(kept), ...windows };
    if (last && sameValues(last.windows, windows)) {
      if (now - last.at < REFRESH_MS) return false;
      last.at = now;
    } else series.push({ from: now, at: now, windows });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, series.map((s) => JSON.stringify(s)).join('\n') + '\n');
      fs.renameSync(tmp, file);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return true;
  } catch { return false; }
}

/**
 * Where window `span`'s current quota went: `cells` equal slices from its opening to its
 * reset, each the % of quota spent in that slice relative to an even spend (1 = on pace),
 * `null` for a slice not yet reached and `undefined` for a past slice with no observation.
 * `now`: % per hour spent over the last observed cell: the speed is read at the
 * resolution the cells show, so a long window is not extrapolated from a noisy hour.
 * A rise between two samples is spread evenly over the time it could have happened in; the
 * first sample's use is spread from the window's opening. Observation stops at `seenUntil`:
 * `now` while the series is fresh, else its last sample. Null when the window has no sample.
 */
export function burn(series, span, { now, cells, seenUntil = now }) {
  const all = series.filter((s) => s.windows?.[span]);
  const last = all.at(-1)?.windows[span];
  if (!last) return null;
  const { resetsAt, windowMs } = last;
  const samples = all.filter((s) => Math.abs(s.windows[span].resetsAt - resetsAt) <= SAME_RESET_MS);
  const start = resetsAt - windowMs;
  // Segments of spend: {t0, t1, mass}; a zero-length one is a point mass at t0.
  const segs = [];
  let prev = { at: start, used: 0 };
  for (const s of samples) {
    const used = s.windows[span].used;
    const mass = used - prev.used;
    if (mass > 0) segs.push({ t0: Math.max(start, prev.at), t1: Math.max(start, prev.at, s.from), mass });
    prev = { at: s.at, used: Math.max(used, prev.used) };
  }
  const spent = (a, b) => segs.reduce((sum, { t0, t1, mass }) => sum + (t1 > t0
    ? mass * Math.max(0, Math.min(b, t1) - Math.max(a, t0)) / (t1 - t0)
    : t0 >= a && t0 < b ? mass : 0), 0);

  const cellMs = windowMs / cells;
  const even = 100 / cells;
  const known = Math.min(seenUntil, now);
  const levels = Array.from({ length: cells }, (_, i) => {
    const a = start + i * cellMs;
    if (a >= now) return null;
    const seen = Math.min(a + cellMs, known) - a;
    return seen > 0 ? spent(a, a + cellMs) / (even * seen / cellMs) : undefined;
  });
  const recent = Math.min(cellMs, known - start);
  return {
    cells: levels,
    // A stale series cannot say how fast the quota goes now.
    now: recent > 0 && known >= now ? spent(known - recent, known + 1) * H / recent : null,
  };
}
