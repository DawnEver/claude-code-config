// scripts/dashboard/public/shared/vocab.mjs — the dashboard's vocabulary, defined once for every
// side: the bridge (status card, quota staleness), the wire format (scripts/shared/
// dashboard-schema.mjs) and the page. It lives under public/ because the page can load only what
// the Worker serves; everything here is plain data and pure functions, no imports.

/** The agents a session or an account belongs to, and how they are named. */
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
export const AGENTS = Object.keys(AGENT_NAMES);
export const agentName = (agent) => AGENT_NAMES[agent] ?? agent;

/**
 * A session's status, as its host reports it (the bridge maps each adapter's native state onto
 * these): the label people read, and `rank`, most urgent first. `ended` is the instant a
 * session goes down; freshness (`stale`) is not a status, the gateway sets it apart.
 */
export const STATUS = {
  needs_approval: { label: 'Needs approval', rank: 0 },
  needs_input: { label: 'Needs input', rank: 1 },
  working: { label: 'Working', rank: 2 },
  idle: { label: 'Idle', rank: 3 },
  unknown: { label: 'Unknown', rank: 4 },
  ended: { label: 'Ended', rank: 5 },
};
export const STATUSES = Object.keys(STATUS);

/** A quota reading older than this is a floor on use and is never projected from. */
export const QUOTA_STALE_MS = 15 * 60000;

/** The Usage tab's filter: at most this many selected values per dimension (the page stops there, the API refuses more). */
export const USAGE_FILTER_MAX = 20;

// A session's tasks (scripts/bridge/tasks.mjs), by kind: a shell (Bash, a Codex command), a
// PowerShell, a monitor (watches until it expires), a subagent. This order is the order a session
// lists them in: subagents, monitors, shells, PowerShell.
export const TASK_KINDS = ['agent', 'monitor', 'shell', 'powershell'];
export const TASK_STATUSES = ['running', 'completed', 'failed', 'stopped'];
/** A task's label (a command, an agent's description) is cut to this many characters. */
export const TASK_LABEL_MAX = 200;
/** What a session waiting for the human waits for (a permission request, a question) is cut to this many characters. */
export const WAITING_MAX = 300;
/** Tasks listed per session at most: running ones first. */
export const MAX_TASKS = 50;
