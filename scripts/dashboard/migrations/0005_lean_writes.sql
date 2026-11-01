-- D1 bills rows written, each index entry included. Nothing reads turns by start time or by
-- project: reports read usage_hours, and the cost query reaches turns by its key
-- (agent, session). These two indexes only made every turn written cost two rows more.
DROP INDEX turns_started;
DROP INDEX turns_project;

-- A session's price is in a report's range when its last turn ended in it. That was a MAX over
-- the session's turns for every price, scanning all of turns (~40k rows read) per report; the
-- host now sends the session's last turn end with its price, and the report reads one index.
ALTER TABLE session_costs ADD COLUMN last_at INTEGER;   -- the session's last turn ended, epoch ms
UPDATE session_costs SET last_at = (SELECT MAX(ended_at) FROM turns t WHERE t.agent = session_costs.agent AND t.session = session_costs.session);
DROP INDEX session_costs_updated;   -- read by nothing
CREATE INDEX session_costs_last ON session_costs (last_at);
