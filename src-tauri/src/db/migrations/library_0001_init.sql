-- Per-root library database. See DATABASE_SCHEMA.md for full column notes.
-- Phase 1 ships the full table shape now (cheap, avoids churny migrations
-- later) even though most fields are populated starting Phase 2+.

CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    extension TEXT NOT NULL,
    folder_rel_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_time INTEGER NOT NULL,
    modified_time INTEGER NOT NULL,
    indexed_time INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    orientation INTEGER,
    rotation INTEGER,
    duration_ms INTEGER,
    fps REAL,
    video_codec TEXT,
    audio_codec TEXT,
    bitrate INTEGER,
    sample_rate INTEGER,
    channels INTEGER,
    container TEXT,
    pixel_format TEXT,
    has_audio INTEGER,
    date_taken INTEGER,
    gps_lat REAL,
    gps_lon REAL,
    camera_make TEXT,
    camera_model TEXT,
    thumbnail_key TEXT,
    thumbnail_state TEXT NOT NULL DEFAULT 'pending',
    metadata_state TEXT NOT NULL DEFAULT 'pending',
    metadata_attempts INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    rating INTEGER NOT NULL DEFAULT 0,
    color_label TEXT,
    notes TEXT,
    playback_position_ms INTEGER NOT NULL DEFAULT 0,
    last_viewed INTEGER,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder_rel_path);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
CREATE INDEX IF NOT EXISTS idx_media_duration ON media(duration_ms);
CREATE INDEX IF NOT EXISTS idx_media_type_duration ON media(media_type, duration_ms);
CREATE INDEX IF NOT EXISTS idx_media_size ON media(file_size);
CREATE INDEX IF NOT EXISTS idx_media_modified ON media(modified_time);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_time);
CREATE INDEX IF NOT EXISTS idx_media_date_taken ON media(date_taken);
CREATE INDEX IF NOT EXISTS idx_media_favorite ON media(favorite);
CREATE INDEX IF NOT EXISTS idx_media_rating ON media(rating);
CREATE INDEX IF NOT EXISTS idx_media_metadata_state ON media(metadata_state);
CREATE INDEX IF NOT EXISTS idx_media_deleted ON media(is_deleted);

CREATE TABLE IF NOT EXISTS folders (
    rel_path TEXT PRIMARY KEY,
    parent_rel_path TEXT,
    name TEXT NOT NULL,
    media_count INTEGER NOT NULL DEFAULT 0,
    depth INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_rel_path);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, tag_id)
);

CREATE TABLE IF NOT EXISTS smart_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS scan_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    cursor TEXT
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_members (
    group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    score REAL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
