-- HPC (Slurm) usage, read by a host that declares it (scripts/bridge/hpc.mjs; docs/dashboard.md "HPC"):
-- one row per cluster login per reading hour. Each reading covers the 24 h before observed_at, so
-- readings a few hours apart overlap: a day's use is its last reading, never a sum of readings.
-- Numbers only: no job name, no path. Fractions are 0..1; NULL is not read.
CREATE TABLE hpc_usage (
  cluster TEXT NOT NULL,          -- the declared cluster's name
  account TEXT NOT NULL,          -- the login (Slurm user) read
  hour INTEGER NOT NULL,          -- the reading's hour, epoch ms (a re-read within the hour replaces it)
  observed_at INTEGER NOT NULL,   -- when it was read
  machine TEXT NOT NULL,          -- the host that read it
  slurm_account TEXT,             -- the Slurm account its first grant names
  role TEXT,                      -- the grant's declared role
  read INTEGER NOT NULL,          -- 1 read; 0 not read, `why` says why
  why TEXT,
  jobs INTEGER,                   -- jobs in the 24 h before observed_at
  core_hours REAL,                -- allocated core-hours of those jobs
  cpu_efficiency REAL,            -- CPU used / allocated, finished jobs only
  completed INTEGER, failed INTEGER, cancelled INTEGER, oom INTEGER, timeout INTEGER, running INTEGER,   -- jobs by state
  storage REAL,                   -- quota used: bytes, fraction of the limit
  files REAL,                     -- quota used: files, fraction of the limit
  budget_core_hours REAL,         -- a billed grant's total allocation over [budget_since, budget_until)
  budget_spent REAL,              -- core-hours spent in it so far
  budget_committed REAL,          -- core-hours its queued and running jobs may still spend
  budget_since TEXT, budget_until TEXT,   -- ISO dates, until exclusive
  budget_window REAL,             -- how much of the window is gone, 0..1
  PRIMARY KEY (cluster, account, hour)
) WITHOUT ROWID;
