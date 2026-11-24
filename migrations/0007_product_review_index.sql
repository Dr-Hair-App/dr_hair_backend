CREATE INDEX IF NOT EXISTS "idx_reviews_product_id_active"
  ON "reviews" (
    json_extract(payload, '$.product_id'),
    json_extract(payload, '$.status'),
    json_extract(payload, '$.consent_verified'),
    json_extract(payload, '$.created_at') DESC
  )
  WHERE json_extract(payload, '$.product_id') IS NOT NULL
    AND json_extract(payload, '$.product_id') <> '';
