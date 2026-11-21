CREATE TABLE IF NOT EXISTS "admin_api_traffic" (
  row_key TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_admin_api_traffic_id_0"
  ON "admin_api_traffic" (json_extract(payload, '$.id') ASC);
CREATE INDEX IF NOT EXISTS "idx_admin_api_traffic_created_at_1"
  ON "admin_api_traffic" (json_extract(payload, '$.created_at') DESC);
CREATE INDEX IF NOT EXISTS "idx_admin_api_traffic_status_2"
  ON "admin_api_traffic" (json_extract(payload, '$.status') ASC);
CREATE INDEX IF NOT EXISTS "idx_admin_api_traffic_route_3"
  ON "admin_api_traffic" (json_extract(payload, '$.route') ASC);
