-- "Similar names" sort: grouping key + trailing number per file. Filled in
-- for new rows by the scanner and for existing rows by a background
-- backfill (see queries::backfill_name_keys).
ALTER TABLE media ADD COLUMN name_key TEXT;
ALTER TABLE media ADD COLUMN name_num INTEGER;
CREATE INDEX IF NOT EXISTS idx_media_name_key ON media(name_key, name_num, filename);
