-- Resume/compatibility migration. No destructive rebuilds: old library DBs
-- keep all existing media ids, ratings, favorites, tags and other user data.

-- Older builds occasionally used 0 for an unresolved video duration.
-- The current pipeline uses NULL as the durable "not resolved yet" marker.
UPDATE media
SET duration_ms = NULL
WHERE media_type = 'video' AND duration_ms IS NOT NULL AND duration_ms <= 0;

-- If a legacy row says OK but still has no usable duration, put it back in
-- the cheap fast lane. Explicit failures remain terminal until user Retry.
UPDATE media
SET metadata_state = 'pending'
WHERE media_type = 'video'
  AND metadata_state = 'ok'
  AND duration_ms IS NULL;

UPDATE media
SET thumbnail_state = 'pending'
WHERE thumbnail_state IS NULL
   OR thumbnail_state NOT IN ('pending', 'ready', 'failed');

UPDATE media
SET metadata_state = 'pending'
WHERE metadata_state IS NULL
   OR metadata_state NOT IN ('pending', 'ok', 'needs_deep_scan', 'failed');

-- Hot resume queries. Including id makes cursor pagination cheap while jobs
-- are concurrently disappearing from the pending set.
CREATE INDEX IF NOT EXISTS idx_media_thumbnail_resume
    ON media(thumbnail_state, is_deleted, id);

CREATE INDEX IF NOT EXISTS idx_media_metadata_resume
    ON media(media_type, metadata_state, is_deleted, id);
