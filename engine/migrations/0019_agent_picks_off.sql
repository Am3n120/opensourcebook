-- A remembered reviewer may be off by default (scopes "<format>.review" only).
ALTER TABLE agent_picks ADD COLUMN off INTEGER NOT NULL DEFAULT 0;
