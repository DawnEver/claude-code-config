#!/usr/bin/env node
// scripts/bridge/install-service.mjs — register the bridge daemon as a per-user service.
//
//   node scripts/bridge/install-service.mjs [install|uninstall|status]
//
// Windows: Task Scheduler task at logon, run through `conhost --headless` so no window.
// macOS:   launchd LaunchAgent (~/Library/LaunchAgents), KeepAlive.
// Linux:   systemd --user unit, Restart=on-failure.
//
// The daemon path goes through the ~/.claude/scripts link, never the checkout path, so a
// moved clone only needs setup re-run. The service definitions themselves are machine-
// local by nature (they name this host's node binary). Idempotent: install overwrites.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { isMain } from '../shared/is-main.mjs';

export const SERVICE_NAME = 'cc-config-bridge';
export const LAUNCHD_LABEL = 'com.cc-config.bridge';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * Pure plan: files to write and commands to run for each action on `platform`.
 * @returns {{ files: {path, content}[], install: string[][], uninstall: string[][], status: string[][], remove: string[] }}
 */
export function planService({ platform = process.platform, home = os.homedir(), nodePath = process.execPath,
  envPath = process.env.PATH ?? '', uid = process.getuid?.() ?? 0 } = {}) {
  const daemon = path.join(home, '.claude', 'scripts', 'bridge', 'daemon.mjs');
  const log = path.join(home, '.claude', 'bridge', 'daemon.log');
  if (platform === 'win32') {
    const tr = `conhost.exe --headless ${q(nodePath)} ${q(daemon)} --log ${q(log)}`;
    return {
      files: [],
      install: [['schtasks', '/Create', '/F', '/TN', SERVICE_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', tr],
        ['schtasks', '/Run', '/TN', SERVICE_NAME]],
      uninstall: [['schtasks', '/End', '/TN', SERVICE_NAME], ['schtasks', '/Delete', '/F', '/TN', SERVICE_NAME]],
      status: [['schtasks', '/Query', '/TN', SERVICE_NAME, '/V', '/FO', 'LIST']],
      remove: [],
    };
  }
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(daemon)}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    const target = `gui/${uid}`;
    return {
      files: [{ path: plist, content }],
      install: [['launchctl', 'bootout', `${target}/${LAUNCHD_LABEL}`, '?'], ['launchctl', 'bootstrap', target, plist]],
      uninstall: [['launchctl', 'bootout', `${target}/${LAUNCHD_LABEL}`, '?']],
      status: [['launchctl', 'print', `${target}/${LAUNCHD_LABEL}`]],
      remove: [plist],
    };
  }
  const unit = path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const content = `[Unit]
Description=cc-config session bridge (Telegram <-> live Claude/Codex sessions)
After=network-online.target

[Service]
ExecStart=${q(nodePath)} ${q(daemon)}
Environment=${q(`PATH=${envPath}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
  return {
    files: [{ path: unit, content }],
    install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', SERVICE_NAME],
      ['systemctl', '--user', 'restart', SERVICE_NAME]],
    uninstall: [['systemctl', '--user', 'disable', '--now', SERVICE_NAME, '?']],
    status: [['systemctl', '--user', 'status', SERVICE_NAME, '--no-pager']],
    remove: [unit],
  };
}

/** Run a plan action. A trailing '?' marks a command whose failure is expected/ignored. */
export function runAction(action, plan, { run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }) } = {}) {
  if (action === 'install') {
    for (const f of plan.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
  }
  let ok = true;
  for (const c of plan[action] ?? []) {
    const optional = c.at(-1) === '?';
    const [cmd, ...args] = optional ? c.slice(0, -1) : c;
    const r = run(cmd, args);
    if (r.status !== 0 && !optional && !(action === 'uninstall')) ok = false;
  }
  if (action === 'uninstall') for (const p of plan.remove) fs.rmSync(p, { force: true });
  return ok;
}

if (isMain(import.meta.url)) {
  const action = process.argv[2] ?? 'install';
  if (!['install', 'uninstall', 'status'].includes(action)) {
    console.error('usage: install-service.mjs [install|uninstall|status]');
    process.exit(2);
  }
  process.exit(runAction(action, planService()) ? 0 : 1);
}
