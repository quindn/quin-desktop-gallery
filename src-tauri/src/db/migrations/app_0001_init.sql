-- Global app database: settings + recent roots. Lives outside any
-- gallery root (see DATABASE_SCHEMA.md), readable before a root is opened.

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_roots (
    canonical_path TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    last_opened INTEGER NOT NULL,
    db_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_roots_last_opened ON recent_roots(last_opened DESC);
