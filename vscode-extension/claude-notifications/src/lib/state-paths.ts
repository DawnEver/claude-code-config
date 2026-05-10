import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

const STATE_ROOT = path.join(os.homedir(), '.claude', 'focus-state');

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  let s = String(workspaceRoot).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    s = s.replace(/^([a-zA-Z]):/, (_m, d) => (d as string).toLowerCase() + ':');
  }
  if (s.length > 1 && s.endsWith('/') && !s.endsWith(':/')) {
    s = s.slice(0, -1);
  }
  return s;
}

function hashWorkspace(workspaceRoot: string): string {
  return crypto.createHash('sha1').update(normalizeWorkspaceRoot(workspaceRoot)).digest('hex').slice(0, 12);
}

export function getStateDir(workspaceRoot: string): string {
  return path.join(STATE_ROOT, hashWorkspace(workspaceRoot));
}

export function getSignalPath(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'signal');
}

export function getSessionsPath(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'sessions');
}

export { normalizeWorkspaceRoot, hashWorkspace, STATE_ROOT };
