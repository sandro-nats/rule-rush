'use strict';
// SQLite via Node's built-in node:sqlite (no npm dependencies). Swap for Postgres when you outgrow one box.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL UNIQUE,          -- Telegram user id (negative = dev login)
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  username      TEXT NOT NULL DEFAULT '',
  photo_url     TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',          -- optional; set when contact is shared
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                    -- sha256 of the cookie token; the raw token is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per official attempt. A row is created the moment the seed is handed out,
-- so quitting mid-run (or peeking at the seed) still uses up the attempt.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  tier          TEXT NOT NULL,
  day           TEXT NOT NULL,                    -- UTC date, YYYY-MM-DD
  attempt_no    INTEGER NOT NULL,
  seed          TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  submitted_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'started',  -- started | verified | rejected | expired
  score         INTEGER NOT NULL DEFAULT 0,
  stats_json    TEXT,
  flags_json    TEXT,
  inputs_json   TEXT,                             -- kept so any score can be re-verified later
  review_status TEXT NOT NULL DEFAULT 'none',     -- none | pending | approved | rejected
  review_note   TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, day, tier, attempt_no)         -- makes the attempt limit race-proof
);
CREATE INDEX IF NOT EXISTS idx_runs_board ON runs(tier, day, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_review ON runs(review_status, status);

CREATE TABLE IF NOT EXISTS sponsors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- A prize is funded by a sponsor and attached to a leaderboard: one tier, one period type (day | week).
-- It applies to every period whose start day lies in [starts_day, ends_day], for ranks rank_from..rank_to.
CREATE TABLE IF NOT EXISTS prizes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor_id  INTEGER NOT NULL REFERENCES prizes(id),
  tier        TEXT NOT NULL,
  period      TEXT NOT NULL,
  starts_day  TEXT NOT NULL,
  ends_day    TEXT NOT NULL,
  rank_from   INTEGER NOT NULL,
  rank_to     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS awards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prize_id   INTEGER NOT NULL REFERENCES prizes(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  period_key TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | delivered | rejected
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (prize_id, period_key, rank)
);
`;

// Fix typo in prizes FK above - prizes.sponsor_id references sponsors not prizes
const SCHEMA_FIXED = SCHEMA.replace(
  'sponsor_id  INTEGER NOT NULL REFERENCES prizes(id)',
  'sponsor_id  INTEGER NOT NULL REFERENCES sponsors(id)'
);

function migrate(db) {
  // Existing DBs created before phone column: add it safely.
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('phone')) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  }
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA_FIXED);
  migrate(db);
  return db;
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { openDb, getMeta, setMeta };
