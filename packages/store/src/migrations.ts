import type Database from 'better-sqlite3'

const SCHEMA_SQL = `
-- Event log — append only, never updated
CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  stored_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);

-- Materialized model cache — rebuilt from events, never source of truth
CREATE TABLE IF NOT EXISTS model_cache (
  project_id   TEXT PRIMARY KEY,
  snapshot     TEXT NOT NULL,
  as_of_event  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Session registry
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  end_reason   TEXT,
  turn_count   INTEGER DEFAULT 0
);

-- Turn log — raw conversation, separate from events
CREATE TABLE IF NOT EXISTS turns (
  turn_id      TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  speaker      TEXT NOT NULL,
  text         TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  classification TEXT,
  extraction_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
`

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL)
}
