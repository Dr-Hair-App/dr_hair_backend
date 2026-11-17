-- Support the ordered history and moderation queries without changing data.
CREATE INDEX IF NOT EXISTS "idx_treatments_user_date_id_read"
  ON "treatments" (
    json_extract(payload, '$.userId') ASC,
    json_extract(payload, '$.date') DESC,
    json_extract(payload, '$.id') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_treatments_date_id_read"
  ON "treatments" (
    json_extract(payload, '$.date') DESC,
    json_extract(payload, '$.id') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_reviews_status_created_at_read"
  ON "reviews" (
    json_extract(payload, '$.status') ASC,
    json_extract(payload, '$.created_at') DESC
  );
