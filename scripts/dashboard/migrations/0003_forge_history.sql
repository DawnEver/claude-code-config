-- The Code tab's history (docs/dashboard.md "Code"): each repository's commits on its default
-- branch and its pull requests, as the hosts that read the forge saw them. Rows are keyed by what
-- the forge itself names them by, so a reading sent twice (or by two hosts) is one row.

CREATE TABLE forge_commits (
  repo TEXT NOT NULL,            -- shared/repo-key.mjs: '<forge host>/<owner>/<name>', lower-cased
  sha TEXT NOT NULL,
  at INTEGER NOT NULL,           -- committed, epoch ms
  author TEXT,                   -- the forge login, else the commit's author name
  PRIMARY KEY (repo, sha)
);
CREATE INDEX forge_commits_at ON forge_commits (repo, at);

CREATE TABLE forge_pulls (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,   -- opened, epoch ms
  merged_at INTEGER,             -- null until merged
  closed_at INTEGER,             -- null while open (a merged PR is closed too)
  author TEXT,
  PRIMARY KEY (repo, number)
);
CREATE INDEX forge_pulls_created ON forge_pulls (repo, created_at);
