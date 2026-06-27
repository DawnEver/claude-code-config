import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// macOS 26+ requires terminal-notifier (UNUserNotificationCenter via proper .app bundle).
// NSUserNotificationCenter and AppleScript display notification are both dead.
export function checkMacNotify() {
  const brewDirs = ['/opt/homebrew/bin', '/usr/local/bin'];
  const notifyBin = brewDirs.map(d => path.join(d, 'terminal-notifier')).find(fs.existsSync);
  if (notifyBin) {
    console.log(`OK    terminal-notifier found: ${notifyBin}`);
    return true;
  }

  // Try auto-install via Homebrew
  const brewBin = brewDirs.map(d => path.join(d, 'brew')).find(fs.existsSync);
  if (!brewBin) {
    console.log('WARN  terminal-notifier not found, and Homebrew is not installed.');
    console.log('      Install Homebrew (https://brew.sh), then: brew install terminal-notifier');
    return false;
  }

  console.log('INSTALL terminal-notifier...');
  try {
    execFileSync(brewBin, ['install', 'terminal-notifier'], { stdio: 'pipe', timeout: 120000 });
    console.log('OK    terminal-notifier installed');
    return true;
  } catch (err) {
    console.log(`ERR   brew install terminal-notifier failed: ${err.stderr?.toString().trim() || err.message}`);
    console.log('      macOS notifications will not work without it.');
    return false;
  }
}
