import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { planService, runAction, SERVICE_NAME } from './install-service.mjs';

const home = path.join(os.tmpdir(), 'svc-home');

test('windows: per-user Run key (no admin), hidden via conhost --headless, daemon via the ~/.claude link', () => {
  const p = planService({ platform: 'win32', home, nodePath: 'C:\\node\\node.exe' });
  const [reg, start] = p.install;
  assert.deepEqual(reg.slice(0, 5), ['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', SERVICE_NAME]);
  const cmd = reg[reg.indexOf('/d') + 1];
  assert.match(cmd, /^conhost\.exe --headless "C:\\node\\node\.exe" /);
  assert.ok(cmd.includes(path.join(home, '.claude', 'scripts', 'bridge', 'daemon.mjs')));
  // Starts now too, detached and hidden; a second daemon refuses to start, so re-install is safe.
  assert.equal(start[0], 'powershell');
  assert.match(start.at(-1), /^Start-Process -WindowStyle Hidden -FilePath 'conhost\.exe' -ArgumentList /);
  assert.ok(!p.install.flat().includes('schtasks'), 'ONLOGON tasks need admin');
  assert.equal(p.uninstall[0][1], 'delete');
  assert.deepEqual(p.files, []);
});

test('macOS: LaunchAgent plist with KeepAlive and PATH', () => {
  const p = planService({ platform: 'darwin', home, nodePath: '/opt/node', envPath: '/usr/bin:/opt/bin', uid: 501 });
  assert.equal(p.files[0].path, path.join(home, 'Library', 'LaunchAgents', 'com.cc-config.bridge.plist'));
  assert.match(p.files[0].content, /<string>\/opt\/node<\/string>/);
  assert.match(p.files[0].content, /\/usr\/bin:\/opt\/bin/);
  assert.deepEqual(p.install.at(-1), ['launchctl', 'bootstrap', 'gui/501', p.files[0].path]);
});

test('linux: systemd --user unit enabled now', () => {
  const p = planService({ platform: 'linux', home, nodePath: '/usr/bin/node' });
  assert.match(p.files[0].content, /ExecStart="\/usr\/bin\/node" ".*daemon\.mjs"/);
  assert.ok(p.install.some((c) => c.join(' ') === `systemctl --user enable --now ${SERVICE_NAME}`));
});

test('runAction is idempotent: install overwrites, uninstall removes, optional failures tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  const ran = [];
  const run = (cmd, args) => { ran.push([cmd, ...args].join(' ')); return { status: cmd === 'launchctl' && args[0] === 'bootout' ? 3 : 0 }; };
  try {
    const p = planService({ platform: 'darwin', home: dir, nodePath: '/n', uid: 1 });
    assert.equal(runAction('install', p, { run }), true);
    assert.equal(runAction('install', p, { run }), true);
    assert.ok(fs.existsSync(p.files[0].path));
    assert.equal(runAction('uninstall', p, { run }), true);
    assert.ok(!fs.existsSync(p.files[0].path));
    assert.ok(ran.every((r) => !r.endsWith('?')), 'the optional marker is not passed through');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
