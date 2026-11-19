CREATE INDEX IF NOT EXISTS idx_clinical_reports_uploaded_by_deleted_created
ON clinical_reports (json_extract(payload, '$.uploaded_by'), json_extract(payload, '$.deleted_at'), json_extract(payload, '$.created_at') DESC);
