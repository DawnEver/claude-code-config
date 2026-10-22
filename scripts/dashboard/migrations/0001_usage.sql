-- The usage store (docs/usage.md): metadata only — never prompt or answer text, never a path.
-- This file is the schema's one description: SQLite keeps it, comments included, in
-- sqlite_master.sql, so `SELECT sql FROM sqlite_master` explains every column to a reader (or an AI).
-- Times are epoch ms (UTC). Tokens are per turn per model, summed over the turn's model calls.

-- One row per turn per model. A turn opens on a prompt and ends at its last model call; the
-- source is the host's own transcript (Claude ~/.claude*/projects, Codex ~/.codex/sessions).
CREATE TABLE turns (
  agent TEXT NOT NULL,          -- 'claude' | 'codex'
  session TEXT NOT NULL,        -- the host's session id (a Claude subagent run belongs to its parent session)
  turn TEXT NOT NULL,           -- turn id, unique within the session
  model TEXT NOT NULL,          -- model id as the provider reported it
  machine TEXT NOT NULL,        -- the host's machine name (scripts/shared/machine.mjs)
  account TEXT,                 -- account key, as the dashboard's quota uses it ('claude:<email>|<org>', 'codex:<email>')
  seat TEXT,                    -- Claude seat alias; NULL for the base config dir and for Codex
  project TEXT,                 -- origin repo name, else the working tree's dir name
  branch TEXT,                  -- git branch: the task (lane) the turn belongs to
  origin TEXT,                  -- who started it: 'human' | 'sdk' | 'peer' | 'task' | 'subagent' | 'system' | ...
  client TEXT,                  -- the host program: Claude entrypoint (cli, sdk-cli, ...), Codex originator/source
  started_at INTEGER NOT NULL,  -- the prompt
  ended_at INTEGER NOT NULL,    -- the turn's last model call or tool result
  calls INTEGER NOT NULL,       -- model calls
  input INTEGER NOT NULL,       -- uncached input tokens
  cache_read INTEGER NOT NULL,  -- input tokens read from the prompt cache
  cache_write INTEGER NOT NULL, -- input tokens written to the prompt cache
  output INTEGER NOT NULL,      -- output tokens, reasoning included
  reasoning INTEGER NOT NULL,   -- of output: thinking / reasoning tokens
  tools TEXT,                   -- JSON {tool name: call count}
  PRIMARY KEY (agent, session, turn, model)
);
CREATE INDEX turns_started ON turns (started_at);
CREATE INDEX turns_project ON turns (project, started_at);

-- What Claude Code itself priced a session at (its transcript's cost-state), per model: the
-- API-list value of the work, not what a subscription is billed. Codex reports no cost.
CREATE TABLE session_costs (
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  model TEXT NOT NULL,
  machine TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, session, model)
);

-- Each quota window an account went through, at the highest use seen in it (use only grows
-- within a window). window_start is the window's opening, rounded to 10 min.
CREATE TABLE quota_windows (
  account TEXT NOT NULL,        -- same key as turns.account
  agent TEXT NOT NULL,
  span TEXT NOT NULL,           -- '5h', '7d', ...
  window_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  used REAL NOT NULL,           -- percent of the window's quota, 0..100
  observed_at INTEGER NOT NULL, -- the last reading
  PRIMARY KEY (account, span, window_start)
);

-- Each machine's load per hour, from the bridge's 15 s samples. Sums, so an hour two daemons
-- sampled merges; averages are sum / samples (see the view resources_hourly).
CREATE TABLE resources (
  machine TEXT NOT NULL,
  hour INTEGER NOT NULL,        -- the hour's start
  samples INTEGER NOT NULL,
  cpu_sum REAL NOT NULL,        -- CPU busy %, summed
  cpu_max REAL NOT NULL,
  mem_sum REAL NOT NULL,        -- memory used, bytes, summed
  mem_max REAL NOT NULL,
  mem_total REAL NOT NULL,
  gpu_sum REAL,                 -- utilisation of the busiest GPU, %, summed; NULL without a GPU
  gpu_max REAL,
  gpu_mem_max REAL,             -- GPU memory used, bytes
  PRIMARY KEY (machine, hour)
);

-- Turns with their duration and the gap since the session's previous turn ended (time the
-- session waited on its human, or sat idle). Durations in ms.
CREATE VIEW turn_times AS
SELECT t.*,
  ended_at - started_at AS active_ms,
  started_at - LAG(ended_at) OVER (PARTITION BY agent, session ORDER BY started_at) AS gap_ms
FROM (SELECT agent, session, turn, MIN(machine) AS machine, MIN(account) AS account, MIN(project) AS project,
    MIN(branch) AS branch, MIN(origin) AS origin, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at,
    SUM(calls) AS calls, SUM(input + cache_read + cache_write + output) AS tokens
  FROM turns GROUP BY agent, session, turn) t;

-- Per UTC day, project, branch, agent and model: the base of every report.
CREATE VIEW daily AS
SELECT date(started_at / 1000, 'unixepoch') AS day, machine, agent, model, project, branch,
  COUNT(DISTINCT session) AS sessions, COUNT(*) AS turns, SUM(calls) AS calls,
  SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
  SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(ended_at - started_at) AS active_ms
FROM turns GROUP BY day, machine, agent, model, project, branch;

-- One row per session.
CREATE VIEW sessions AS
SELECT agent, session, MIN(machine) AS machine, MIN(account) AS account, MIN(project) AS project, MIN(branch) AS branch,
  MIN(started_at) AS started_at, MAX(ended_at) AS ended_at, COUNT(DISTINCT turn) AS turns, SUM(calls) AS calls,
  SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output,
  (SELECT SUM(cost_usd) FROM session_costs c WHERE c.agent = turns.agent AND c.session = turns.session) AS cost_usd
FROM turns GROUP BY agent, session;

CREATE VIEW resources_hourly AS
SELECT machine, hour, samples, cpu_sum / samples AS cpu_avg, cpu_max, mem_sum / samples AS mem_avg, mem_max, mem_total,
  gpu_sum / samples AS gpu_avg, gpu_max, gpu_mem_max
FROM resources;
