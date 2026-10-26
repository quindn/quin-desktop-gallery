-- Sort paths that had no index (name sort, the Dashboard's "recently
-- added"), so they no longer sort the whole table on every request.
CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);
CREATE INDEX IF NOT EXISTS idx_media_indexed ON media(indexed_time);
