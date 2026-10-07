import type { Database } from 'better-sqlite3';

/**
 * Single forward-only schema. Everything the second iteration needs — new event
 * types, new step ids, new config shapes — lives in TEXT/JSON columns, so
 * publishing a new funnel version never touches the schema.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funnel_versions (
  version     INTEGER PRIMARY KEY,
  funnel_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  config_json TEXT    NOT NULL,
  config_hash TEXT    NOT NULL,
  source_file TEXT,
  notes       TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS funnel_active (
  funnel_id  TEXT    PRIMARY KEY,
  version    INTEGER NOT NULL REFERENCES funnel_versions(version),
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS version_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_id    TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  from_version INTEGER,
  to_version   INTEGER NOT NULL,
  actor        TEXT    NOT NULL,
  note         TEXT,
  at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT    PRIMARY KEY,
  funnel_id      TEXT    NOT NULL,
  funnel_version INTEGER NOT NULL REFERENCES funnel_versions(version),
  variant        TEXT    NOT NULL,
  variant_source TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  completed_at   TEXT,
  current_step   TEXT    NOT NULL,
  answers_json   TEXT    NOT NULL DEFAULT '{}',
  history_json   TEXT    NOT NULL DEFAULT '[]',
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  user_agent     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_version ON sessions(funnel_version);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

-- event_id as the primary key is the whole deduplication story: a replayed
-- batch collides on the key and is ignored instead of inserted twice.
CREATE TABLE IF NOT EXISTS events (
  event_id       TEXT    PRIMARY KEY,
  session_id     TEXT    NOT NULL,
  event_type     TEXT    NOT NULL,
  step_id        TEXT,
  funnel_id      TEXT    NOT NULL,
  funnel_version INTEGER NOT NULL,
  variant        TEXT    NOT NULL,
  client_ts      TEXT    NOT NULL,
  server_ts      TEXT    NOT NULL,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  props_json     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_type_step  ON events(event_type, step_id);
CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_version    ON events(funnel_version);
CREATE INDEX IF NOT EXISTS idx_events_variant    ON events(variant);
CREATE INDEX IF NOT EXISTS idx_events_campaign   ON events(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_events_server_ts  ON events(server_ts);

-- Rejected payloads are kept out of the events table so they can never reach
-- an aggregate, but they are not thrown away either: the admin UI shows them.
-- Ingest tallies. Deduplication is silent by design (INSERT OR IGNORE leaves no
-- row behind), so the count of suppressed replays is recorded here instead —
-- otherwise there would be no way to show that idempotency actually fired.
CREATE TABLE IF NOT EXISTS ingest_counters (
  key   TEXT    PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_rejects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  event_id     TEXT,
  session_id   TEXT,
  event_type   TEXT,
  payload_json TEXT NOT NULL
);
`;

export const SCHEMA_VERSION = '1';

export function migrate(db: Database): void {
  db.exec(DDL);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_VERSION);
}
