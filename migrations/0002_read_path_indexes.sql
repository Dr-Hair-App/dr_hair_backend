-- Cover the highest-volume list queries without changing stored data.
CREATE INDEX IF NOT EXISTS "idx_videos_status_created_at_read"
  ON "videos" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_videos_status_placement_created_at_read"
  ON "videos" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.placement') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_content_items_status_type_sort_created_read"
  ON "content_items" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.type') ASC, json_extract(payload, '$.sortOrder') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_notifications_user_read_created_read"
  ON "notifications" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.isRead') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_hair_tests_user_created_read"
  ON "hair_tests" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.created_at') DESC);
