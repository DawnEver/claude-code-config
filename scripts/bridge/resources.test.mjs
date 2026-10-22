import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmi, parseVmStat, ResourceReader } from './resources.mjs';
import { parseHostPush } from '../shared/dashboard-schema.mjs';

const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });

test('nvidia-smi CSV -> GPUs in bytes; junk lines dropped', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA RTX 4090, 37, 1024, 24564\r\nbad line\n'),
    [{ name: 'NVIDIA RTX 4090', util: 37, memUsed: 1024 * 1048576, memTotal: 24564 * 1048576 }]);
});

test('vm_stat -> available bytes: free plus reclaimable pages', () => {
  const out = ['Mach Virtual Memory Statistics: (page size of 16384 bytes)', 'Pages free:      10.', 'Pages active:   500.',
    'Pages inactive:  20.', 'Pages speculative: 3.', 'Pages purgeable: 2.'].join('\n');
  assert.equal(parseVmStat(out), 16384 * 35);
  assert.equal(parseVmStat('garbage'), null);
});

test('macOS memory comes from vm_stat, not os.freemem', () => {
  const r = new ResourceReader({ platform: 'darwin',
    exec: (cmd, args, opts, cb) => (cmd === 'vm_stat' ? cb(null, 'page size of 4096 bytes\nPages free: 1.\n') : cb(missing())) });
  r.read();
  const s = r.read();
  assert.equal(s.mem.used, s.mem.total - 4096);
});

test('a host without nvidia-smi reports no GPU and stops asking', () => {
  let calls = 0;
  const r = new ResourceReader({ platform: 'win32', exec: (cmd, args, opts, cb) => { calls++; cb(missing()); } });
  const s = r.read();
  r.read();
  assert.equal(calls, 1);
  assert.deepEqual(r.read().gpus, []);
  assert.ok(s.mem.total > 0 && s.cores > 0);
});

test('schema bounds resources and keeps only numbers and a GPU name', () => {
  const p = parseHostPush({ schemaVersion: 1, bootAt: 1, seq: 1, sessions: [],
    resources: { cpu: 140, cores: 8, mem: { used: 5, total: 10 }, gpus: [{ name: 'g', util: 50, memUsed: 99, memTotal: 10, pid: 1 }, { name: 'x' }], extra: 1 } });
  assert.deepEqual(p.resources, { cpu: null, cores: 8, mem: { used: 5, total: 10 }, gpus: [{ name: 'g', util: 50, memUsed: 0, memTotal: 10 }] });
});
