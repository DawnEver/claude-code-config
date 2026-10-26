-- The Usage tab's base (docs/usage.md "Budget"): turns rolled up per UTC hour, so a report reads a
-- few rows per active hour instead of every turn of its range. Derived, never written directly:
-- the triggers below keep it equal to `SELECT ... FROM turns GROUP BY hour, agent, project, model, machine`.

CREATE TABLE usage_hours (
  hour INTEGER NOT NULL,        -- the UTC hour's start, epoch ms, of the turns' started_at
  agent TEXT NOT NULL,
  project TEXT NOT NULL,        -- turns.project, '' for none
  model TEXT NOT NULL,
  machine TEXT NOT NULL,
  turns INTEGER NOT NULL,       -- turn rows (one per turn per model)
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  active_ms INTEGER NOT NULL,   -- turn durations summed
  PRIMARY KEY (hour, agent, project, model, machine)
);

INSERT INTO usage_hours
SELECT started_at / 3600000 * 3600000, agent, COALESCE(project, ''), model, machine,
  COUNT(*), SUM(input), SUM(cache_read), SUM(cache_write), SUM(output), SUM(ended_at - started_at)
FROM turns WHERE true GROUP BY 1, 2, 3, 4, 5;

CREATE TRIGGER usage_hours_insert AFTER INSERT ON turns BEGIN
  INSERT INTO usage_hours VALUES (NEW.started_at / 3600000 * 3600000, NEW.agent, COALESCE(NEW.project, ''), NEW.model, NEW.machine,
    1, NEW.input, NEW.cache_read, NEW.cache_write, NEW.output, NEW.ended_at - NEW.started_at)
  ON CONFLICT DO UPDATE SET turns = turns + 1, input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write, output = output + excluded.output, active_ms = active_ms + excluded.active_ms;
END;

-- A turn that grew in place (the common rewrite): one delta on its own row.
CREATE TRIGGER usage_hours_grow AFTER UPDATE ON turns
WHEN NEW.started_at / 3600000 = OLD.started_at / 3600000 AND COALESCE(NEW.project, '') = COALESCE(OLD.project, '')
  AND NEW.machine = OLD.machine
BEGIN
  UPDATE usage_hours SET input = input + NEW.input - OLD.input, cache_read = cache_read + NEW.cache_read - OLD.cache_read,
    cache_write = cache_write + NEW.cache_write - OLD.cache_write, output = output + NEW.output - OLD.output,
    active_ms = active_ms + (NEW.ended_at - NEW.started_at) - (OLD.ended_at - OLD.started_at)
  WHERE hour = OLD.started_at / 3600000 * 3600000 AND agent = OLD.agent AND project = COALESCE(OLD.project, '')
    AND model = OLD.model AND machine = OLD.machine;
END;

-- A turn that moved to another row (hour, project or machine changed): out of the old, into the new.
CREATE TRIGGER usage_hours_move AFTER UPDATE ON turns
WHEN NOT (NEW.started_at / 3600000 = OLD.started_at / 3600000 AND COALESCE(NEW.project, '') = COALESCE(OLD.project, '')
  AND NEW.machine = OLD.machine)
BEGIN
  UPDATE usage_hours SET turns = turns - 1, input = input - OLD.input, cache_read = cache_read - OLD.cache_read,
    cache_write = cache_write - OLD.cache_write, output = output - OLD.output, active_ms = active_ms - (OLD.ended_at - OLD.started_at)
  WHERE hour = OLD.started_at / 3600000 * 3600000 AND agent = OLD.agent AND project = COALESCE(OLD.project, '')
    AND model = OLD.model AND machine = OLD.machine;
  DELETE FROM usage_hours WHERE turns = 0 AND hour = OLD.started_at / 3600000 * 3600000 AND agent = OLD.agent
    AND project = COALESCE(OLD.project, '') AND model = OLD.model AND machine = OLD.machine;
  INSERT INTO usage_hours VALUES (NEW.started_at / 3600000 * 3600000, NEW.agent, COALESCE(NEW.project, ''), NEW.model, NEW.machine,
    1, NEW.input, NEW.cache_read, NEW.cache_write, NEW.output, NEW.ended_at - NEW.started_at)
  ON CONFLICT DO UPDATE SET turns = turns + 1, input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write, output = output + excluded.output, active_ms = active_ms + excluded.active_ms;
END;

CREATE TRIGGER usage_hours_delete AFTER DELETE ON turns BEGIN
  UPDATE usage_hours SET turns = turns - 1, input = input - OLD.input, cache_read = cache_read - OLD.cache_read,
    cache_write = cache_write - OLD.cache_write, output = output - OLD.output, active_ms = active_ms - (OLD.ended_at - OLD.started_at)
  WHERE hour = OLD.started_at / 3600000 * 3600000 AND agent = OLD.agent AND project = COALESCE(OLD.project, '')
    AND model = OLD.model AND machine = OLD.machine;
  DELETE FROM usage_hours WHERE turns = 0 AND hour = OLD.started_at / 3600000 * 3600000 AND agent = OLD.agent
    AND project = COALESCE(OLD.project, '') AND model = OLD.model AND machine = OLD.machine;
END;

-- A report's API value: sessions whose price changed in its range, by an index instead of a turns scan.
CREATE INDEX session_costs_updated ON session_costs (updated_at);
