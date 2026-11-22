import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HpcReader, budgetAlert, hpcConfig, hpcRows } from './hpc.mjs';

const NOW = Date.parse('2027-02-01T10:20:00Z');
const REPORT = {
  schema: 1,
  window_hours: 24,
  grants: [
    { cluster: 'c', account: 'svc', slurm_account: 'acct', role: 'verification', read: true, jobs: 7, core_hours: 42.5, cpu_efficiency: 0.8,
      states: { COMPLETED: 2, FAILED: 1, CANCELLED: 1, OUT_OF_MEMORY: 2, TIMEOUT: 1, RUNNING: 1, PENDING: 3 }, forge_share: 0.5,
      quota: { bytes: 0.5, files: 0.3 }, budget: null },
    { cluster: 'c', account: 'lab', slurm_account: 'acct', role: 'research', read: true, jobs: 0, core_hours: 0, cpu_efficiency: null,
      states: {}, quota: null,
      budget: { core_hours: 20000, spent: 15000, committed: 80, since: '2026-08-01', until: '2027-08-01', window: 0.5041 } },
    { cluster: 'd', account: 'gone', slurm_account: 'acct', role: 'research', read: false, why: 'no login host answered' },
  ],
};

test('config: off unless the local layer declares a command; the cadence is hours', () => {
  assert.equal(hpcConfig(undefined), null);
  assert.equal(hpcConfig({}), null, 'a block without a command is off');
  assert.deepEqual(hpcConfig({ command: ['py', '-m', 'door'] }), { command: ['py', '-m', 'door'], everyMs: 6 * 3600000 });
  assert.deepEqual(hpcConfig({ command: ['py'], everyHours: 24 }).everyMs, 24 * 3600000);
  assert.throws(() => hpcConfig({ command: 'py -m door' }), /command.*argv/);
  assert.throws(() => hpcConfig({ command: ['py'], everyHours: 0.1 }), /everyHours/);
});

test('rows: one per login and reading hour, numbers only; an unread login keeps its reason', () => {
  const rows = hpcRows(REPORT, NOW);
  assert.equal(rows.length, 3);
  const [svc, lab, gone] = rows;
  assert.deepEqual(svc, { cluster: 'c', account: 'svc', hour: Date.parse('2027-02-01T10:00:00Z'), observed_at: NOW, slurm_account: 'acct',
    role: 'verification', read: 1, why: null, jobs: 7, core_hours: 42.5, cpu_efficiency: 0.8, completed: 2, failed: 1, cancelled: 1, oom: 2,
    timeout: 1, running: 1, storage: 0.5, files: 0.3, budget_core_hours: null, budget_spent: null, budget_committed: null,
    budget_since: null, budget_until: null, budget_window: null });
  assert.equal(lab.budget_spent, 15000);
  assert.equal(lab.budget_until, '2027-08-01');
  assert.equal(gone.read, 0);
  assert.equal(gone.why, 'no login host answered');
  assert.equal(gone.core_hours, null, 'an unread login is no zero');
  assert.throws(() => hpcRows({ ...REPORT, schema: 2 }, NOW), /schema 2/, 'a report shape this reader does not know is refused by name');
});

test('budget alert: a billed grant spending past its total before its window ends; quiet when on pace', () => {
  const [, lab] = hpcRows(REPORT, NOW);
  assert.deepEqual(budgetAlert(lab), { kind: 'hpc-budget', grant: 'c/lab', spent: 15000, committed: 80, total: 20000, window: 0.5041,
    until: '2027-08-01', projected: Math.round(15000 / 0.5041) });
  assert.equal(budgetAlert({ ...lab, budget_spent: 5000 }), null, 'on pace: no alert');
  assert.ok(budgetAlert({ ...lab, budget_spent: 19000, budget_committed: 1500 }), 'spent plus committed past the total alerts');
  assert.equal(budgetAlert({ ...lab, budget_core_hours: null }), null, 'a free grant never alerts');
});

test('reader: reads on its cadence across restarts, raises a budget alert once per condition, says why a read failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-'));
  try {
    const file = path.join(dir, 'hpc.json');
    let now = NOW, runs = 0, out = JSON.stringify(REPORT);
    const alerts = [], logs = [];
    const make = () => new HpcReader({ command: ['door'], everyMs: 6 * 3600000, stateFile: file, now: () => now, log: (l) => logs.push(l),
      run: async () => { runs++; return out; }, raise: (a) => alerts.push(a) });
    const r = make();
    await r.tick();
    assert.equal(runs, 1);
    const taken = r.take();
    assert.equal(taken.rows.length, 3);
    assert.equal(r.take()?.rows.length, 3, 'rows stay until stored');
    taken.stored();
    assert.equal(r.take(), null);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'hpc-budget');
    assert.match(alerts[0].id, /^hpc-[0-9a-f]{12}$/);

    now += 3600000;
    const again = make();   // a daemon hand-over within the cadence
    await again.tick();
    assert.equal(runs, 1, 'a restart does not read again before its cadence');

    now += 6 * 3600000;
    await again.tick();
    assert.equal(runs, 2);
    assert.equal(alerts.length, 1, 'a standing condition alerts once');

    out = JSON.stringify({ ...REPORT, grants: [{ ...REPORT.grants[1], budget: { ...REPORT.grants[1].budget, spent: 1000 } }] });
    now += 6 * 3600000;
    await again.tick();
    out = JSON.stringify(REPORT);
    now += 6 * 3600000;
    await again.tick();
    assert.equal(alerts.length, 2, 'recovered, then over again: a new condition alerts');

    out = 'not json';
    now += 6 * 3600000;
    await again.tick();
    assert.match(logs.at(-1), /^hpc: read failed \(.+\); next in 6 h$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
