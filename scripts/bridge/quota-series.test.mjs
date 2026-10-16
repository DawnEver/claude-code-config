import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { burn, readSeries, recordSample } from './quota-series.mjs';

const H = 3600000;
const T0 = Date.UTC(2026, 9, 3, 7, 0);   // a 5h window opens here
const W5 = (used, resetsAt = T0 + 5 * H) => ({ '5h': { used, resetsAt, windowMs: 5 * H } });
const sample = (from, at, used) => ({ from, at, windows: W5(used) });

test('recordSample grows with change, not time: an unchanged reading only moves `at`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  try {
    const file = path.join(dir, 'b', 'usage.jsonl');
    assert.equal(recordSample(file, null, T0), false);
    assert.equal(recordSample(file, W5(10), T0), true);
    assert.equal(recordSample(file, W5(10), T0 + 30000), false, 'unchanged within a minute: nothing written');
    assert.equal(recordSample(file, W5(10), T0 + 90000), true);
    assert.equal(recordSample(file, W5(12), T0 + 120000), true);
    assert.deepEqual(readSeries(file).map((s) => [s.from - T0, s.at - T0, s.windows['5h'].used]), [[0, 90000, 10], [120000, 120000, 12]]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['usage.jsonl'], 'no temp file left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recordSample: a window missing from one reading keeps its last current value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  try {
    const file = path.join(dir, 'usage.jsonl');
    const w7 = { '7d': { used: 68, resetsAt: T0 + 100 * H, windowMs: 168 * H } };
    recordSample(file, { ...W5(0), ...w7 }, T0);
    assert.equal(recordSample(file, w7, T0 + 5000), false, 'nothing new: no sample');
    assert.deepEqual(Object.keys(readSeries(file).at(-1).windows), ['5h', '7d']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recordSample drops samples whose every window has reset: retention is the windows themselves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  try {
    const file = path.join(dir, 'usage.jsonl');
    recordSample(file, W5(50), T0 + H);
    recordSample(file, W5(3, T0 + 10 * H), T0 + 6 * H);
    assert.deepEqual(readSeries(file).map((s) => s.windows['5h'].used), [3]);
    fs.appendFileSync(file, 'not json\n');
    assert.equal(readSeries(file).length, 1, 'a torn line is skipped');
    assert.deepEqual(readSeries(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('burn: one sample spreads its use evenly from the window opening, the honest average', () => {
  // 2h in, 40% used: an even 20%/h, exactly on pace -> every past cell is 1.
  const b = burn([sample(T0 + 2 * H, T0 + 2 * H, 40)], '5h', { now: T0 + 2 * H, cells: 5 });
  assert.deepEqual(b.cells.map((c) => (c == null ? c : +c.toFixed(6))), [1, 1, null, null, null]);
  assert.equal(Math.round(b.now), 20);
});

test('burn: a rise is placed between the last sight of the old value and the first of the new', () => {
  const series = [sample(T0 + 0.5 * H, T0 + 2 * H, 0), sample(T0 + 2.5 * H, T0 + 3 * H, 30)];
  const b = burn(series, '5h', { now: T0 + 3 * H, cells: 5 });
  // 30% fell in 2h..2.5h, all in cell 2: 30% where an even cell is 20% -> 1.5.
  assert.deepEqual(b.cells.map((c) => (c == null ? c : +c.toFixed(6))), [0, 0, 1.5, null, null]);
  assert.equal(Math.round(b.now), 30, 'the last hour spent 30%');
});

test('burn: only the current window counts; past cells after a stale series are unknown', () => {
  const old = { from: T0 - 4 * H, at: T0 - 4 * H, windows: W5(90, T0) };
  const b = burn([old, sample(T0 + H, T0 + H, 20)], '5h', { now: T0 + 3 * H, cells: 5, seenUntil: T0 + H });
  assert.deepEqual(b.cells.map((c) => (c == null || c === undefined ? c : +c.toFixed(6))), [1, undefined, undefined, null, null]);
  assert.equal(b.now, null, 'a stale series cannot say how fast it goes now');
  assert.equal(burn([], '5h', { now: T0, cells: 5 }), null);
});
