-- Lowercase expression indexes for product catalog filtering and sorting.
CREATE INDEX IF NOT EXISTS "idx_products_status_lower_category_created_at"
  ON "products" (
    json_extract(payload, '$.status') ASC,
    LOWER(json_extract(payload, '$.category')) ASC,
    json_extract(payload, '$.created_at') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_products_lower_category_created_at"
  ON "products" (
    LOWER(json_extract(payload, '$.category')) ASC,
    json_extract(payload, '$.created_at') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_products_status_lower_root_cause_created_at"
  ON "products" (
    json_extract(payload, '$.status') ASC,
    LOWER(json_extract(payload, '$.root_cause')) ASC,
    json_extract(payload, '$.created_at') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_products_lower_root_cause_created_at"
  ON "products" (
    LOWER(json_extract(payload, '$.root_cause')) ASC,
    json_extract(payload, '$.created_at') DESC
  );

CREATE INDEX IF NOT EXISTS "idx_products_status_lower_root_causes_created_at"
  ON "products" (
    json_extract(payload, '$.status') ASC,
    LOWER(json_extract(payload, '$.root_causes')) ASC,
    json_extract(payload, '$.created_at') DESC
  );
