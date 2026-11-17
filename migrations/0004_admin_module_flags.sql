-- Persist the admin navigation module controls in D1. These flags control UI
-- visibility only; resource APIs continue to enforce their own permissions.
INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-patients', json_object('_id', 'seed-admin-module-patients', 'key', 'admin_patients', 'title', 'Patients & assessments', 'description', 'Patient profiles, assessment review, and treatment history.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));

INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-catalog', json_object('_id', 'seed-admin-module-catalog', 'key', 'admin_catalog', 'title', 'Product catalog', 'description', 'Product content, pricing, supply plans, and stock state.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));

INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-content', json_object('_id', 'seed-admin-module-content', 'key', 'admin_content', 'title', 'App Management', 'description', 'Content, home placements, and app-facing experiences.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));

INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-orders', json_object('_id', 'seed-admin-module-orders', 'key', 'admin_orders', 'title', 'Orders', 'description', 'Order list, fulfilment state, and customer details.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));

INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-bookings', json_object('_id', 'seed-admin-module-bookings', 'key', 'admin_bookings', 'title', 'Clinic appointments', 'description', 'Clinic appointments and treatment operations.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));

INSERT OR IGNORE INTO feature_flags (row_key, payload) VALUES
('seed-admin-module-tests', json_object('_id', 'seed-admin-module-tests', 'key', 'admin_tests', 'title', 'Hair tests & reports', 'description', 'Patient test uploads, clinical review, and report sharing workflow.', 'group', 'Admin panel access', 'enabled', json('true'), 'platform', 'admin', 'rolloutPercentage', 100, 'updatedBy', 'System', 'created_at', CURRENT_TIMESTAMP, 'updated_at', CURRENT_TIMESTAMP));
