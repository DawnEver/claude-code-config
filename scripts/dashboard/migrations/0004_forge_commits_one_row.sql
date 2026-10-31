-- One written row per commit (D1 bills rows written, each index entry included): the table is
-- its own index, keyed by what the Code tab reads it by (repo, then time). A commit's sha
-- fixes its time, so (repo, at, sha) is as unique as (repo, sha) was. The old table wrote three
-- rows per commit (table, primary-key index, time index) and a year's backfill overran the
-- free plan's daily writes.

CREATE TABLE forge_commits_new (
  repo TEXT NOT NULL,            -- shared/repo-key.mjs: '<forge host>/<owner>/<name>', lower-cased
  at INTEGER NOT NULL,           -- committed, epoch ms
  sha TEXT NOT NULL,
  author TEXT,                   -- the forge login, else the commit's author name
  PRIMARY KEY (repo, at, sha)
) WITHOUT ROWID;
INSERT INTO forge_commits_new (repo, at, sha, author) SELECT repo, at, sha, author FROM forge_commits;
DROP TABLE forge_commits;
ALTER TABLE forge_commits_new RENAME TO forge_commits;
