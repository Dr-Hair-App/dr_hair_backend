-- A retry from the same patient must never create a second assessment.
-- Existing records without a submission key remain unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hair_tests_patient_submission_key
ON hair_tests (json_extract(payload, '$.userId'), json_extract(payload, '$.submission_key'))
WHERE json_type(payload, '$.submission_key') = 'text';
