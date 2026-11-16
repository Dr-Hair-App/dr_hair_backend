-- Initial D1 schema for the development environment. No data is seeded.
CREATE TABLE IF NOT EXISTS "addresses" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_addresses_id_0" ON "addresses" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_addresses_userId_1" ON "addresses" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_addresses_userId_is_default_2" ON "addresses" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.is_default') ASC);

CREATE TABLE IF NOT EXISTS "admin_accounts" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_admin_accounts_email_0" ON "admin_accounts" (json_extract(payload, '$.email') ASC);

CREATE INDEX IF NOT EXISTS "idx_admin_accounts_active_1" ON "admin_accounts" (json_extract(payload, '$.active') ASC);

CREATE TABLE IF NOT EXISTS "app_release_policies" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_release_policies_platform_0" ON "app_release_policies" (json_extract(payload, '$.platform') ASC);

CREATE TABLE IF NOT EXISTS "clinic_appointments" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinic_appointments_id_0" ON "clinic_appointments" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_userId_1" ON "clinic_appointments" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_starts_at_2" ON "clinic_appointments" (json_extract(payload, '$.starts_at') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinic_appointments_slot_key_3" ON "clinic_appointments" (json_extract(payload, '$.slot_key') ASC) WHERE json_type(payload, '$.slot_key') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_status_4" ON "clinic_appointments" (json_extract(payload, '$.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_payment_status_5" ON "clinic_appointments" (json_extract(payload, '$.payment_status') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_userId_starts_at_6" ON "clinic_appointments" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.starts_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_clinic_appointments_starts_at_status_7" ON "clinic_appointments" (json_extract(payload, '$.starts_at') ASC, json_extract(payload, '$.status') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinic_appointments_payment_transaction_id_8" ON "clinic_appointments" (json_extract(payload, '$.payment_transaction_id') ASC) WHERE json_type(payload, '$.payment_transaction_id') = 'text' AND json_extract(payload, '$.payment_transaction_id') <> '';

CREATE TABLE IF NOT EXISTS "audit_events" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_audit_events_id_0" ON "audit_events" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_audit_events_actorId_1" ON "audit_events" (json_extract(payload, '$.actorId') ASC);

CREATE INDEX IF NOT EXISTS "idx_audit_events_target_2" ON "audit_events" (json_extract(payload, '$.target') ASC);

CREATE INDEX IF NOT EXISTS "idx_audit_events_action_3" ON "audit_events" (json_extract(payload, '$.action') ASC);

CREATE INDEX IF NOT EXISTS "idx_audit_events_created_at_4" ON "audit_events" (json_extract(payload, '$.created_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_audit_events_created_at_action_5" ON "audit_events" (json_extract(payload, '$.created_at') DESC, json_extract(payload, '$.action') ASC);

CREATE TABLE IF NOT EXISTS "carts" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_carts_userId_0" ON "carts" (json_extract(payload, '$.userId') ASC);

CREATE TABLE IF NOT EXISTS "categories" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS "idx_categories_type_status_display_order_created_at_0" ON "categories" (json_extract(payload, '$.type') ASC, json_extract(payload, '$.status') ASC, json_extract(payload, '$.display_order') ASC, json_extract(payload, '$.created_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_categories_slug_type_1" ON "categories" (json_extract(payload, '$.slug') ASC, json_extract(payload, '$.type') ASC);

CREATE TABLE IF NOT EXISTS "clinic_closed_dates" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinic_closed_dates_date_0" ON "clinic_closed_dates" (json_extract(payload, '$.date') ASC);

CREATE TABLE IF NOT EXISTS "clinical_reports" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinical_reports_id_0" ON "clinical_reports" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_userId_1" ON "clinical_reports" (json_extract(payload, '$.userId') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_clinical_reports_public_id_2" ON "clinical_reports" (json_extract(payload, '$.public_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_deleted_at_3" ON "clinical_reports" (json_extract(payload, '$.deleted_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_purge_after_4" ON "clinical_reports" (json_extract(payload, '$.purge_after') ASC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_userId_created_at_5" ON "clinical_reports" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_userId_visibility_created_at_6" ON "clinical_reports" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.visibility') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_clinical_reports_deleted_at_purge_after_7" ON "clinical_reports" (json_extract(payload, '$.deleted_at') ASC, json_extract(payload, '$.purge_after') ASC);

CREATE TABLE IF NOT EXISTS "content_items" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_content_items_id_0" ON "content_items" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_type_1" ON "content_items" (json_extract(payload, '$.type') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_placement_2" ON "content_items" (json_extract(payload, '$.placement') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_status_3" ON "content_items" (json_extract(payload, '$.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_sortOrder_4" ON "content_items" (json_extract(payload, '$.sortOrder') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_created_at_5" ON "content_items" (json_extract(payload, '$.created_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_content_items_type_placement_status_sortOrder_6" ON "content_items" (json_extract(payload, '$.type') ASC, json_extract(payload, '$.placement') ASC, json_extract(payload, '$.status') ASC, json_extract(payload, '$.sortOrder') ASC);

CREATE TABLE IF NOT EXISTS "coupons" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_coupons_id_0" ON "coupons" (json_extract(payload, '$.id') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_coupons_code_1" ON "coupons" (json_extract(payload, '$.code') ASC);

CREATE INDEX IF NOT EXISTS "idx_coupons_status_2" ON "coupons" (json_extract(payload, '$.status') ASC);

CREATE TABLE IF NOT EXISTS "device_tokens" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS "idx_device_tokens_userId_0" ON "device_tokens" (json_extract(payload, '$.userId') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_tokens_token_1" ON "device_tokens" (json_extract(payload, '$.token') ASC);

CREATE TABLE IF NOT EXISTS "feature_flags" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_feature_flags_key_0" ON "feature_flags" (json_extract(payload, '$.key') ASC);

CREATE INDEX IF NOT EXISTS "idx_feature_flags_enabled_1" ON "feature_flags" (json_extract(payload, '$.enabled') ASC);

CREATE TABLE IF NOT EXISTS "hair_test_drafts" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_hair_test_drafts_userId_0" ON "hair_test_drafts" (json_extract(payload, '$.userId') ASC);

CREATE TABLE IF NOT EXISTS "hair_tests" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_hair_tests_id_0" ON "hair_tests" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_hair_tests_userId_1" ON "hair_tests" (json_extract(payload, '$.userId') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_hair_tests_reference_no_2" ON "hair_tests" (json_extract(payload, '$.reference_no') ASC);

CREATE INDEX IF NOT EXISTS "idx_hair_tests_status_3" ON "hair_tests" (json_extract(payload, '$.status') ASC);

CREATE TABLE IF NOT EXISTS "inventory_ledgers" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_inventory_ledgers_id_0" ON "inventory_ledgers" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_inventory_ledgers_product_id_1" ON "inventory_ledgers" (json_extract(payload, '$.product_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_inventory_ledgers_reference_type_2" ON "inventory_ledgers" (json_extract(payload, '$.reference_type') ASC);

CREATE INDEX IF NOT EXISTS "idx_inventory_ledgers_reference_id_3" ON "inventory_ledgers" (json_extract(payload, '$.reference_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_inventory_ledgers_product_id_created_at_4" ON "inventory_ledgers" (json_extract(payload, '$.product_id') ASC, json_extract(payload, '$.created_at') DESC);

CREATE TABLE IF NOT EXISTS "inventory_operations" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_inventory_operations_operation_type_reference_id_product_id_0" ON "inventory_operations" (json_extract(payload, '$.operation_type') ASC, json_extract(payload, '$.reference_id') ASC, json_extract(payload, '$.product_id') ASC);

CREATE TABLE IF NOT EXISTS "notification_campaigns" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_notification_campaigns_id_0" ON "notification_campaigns" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_notification_campaigns_audience_1" ON "notification_campaigns" (json_extract(payload, '$.audience') ASC);

CREATE INDEX IF NOT EXISTS "idx_notification_campaigns_status_2" ON "notification_campaigns" (json_extract(payload, '$.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_notification_campaigns_scheduledAt_3" ON "notification_campaigns" (json_extract(payload, '$.scheduledAt') ASC);

CREATE INDEX IF NOT EXISTS "idx_notification_campaigns_created_at_4" ON "notification_campaigns" (json_extract(payload, '$.created_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_notification_campaigns_status_scheduledAt_5" ON "notification_campaigns" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.scheduledAt') ASC);

CREATE TABLE IF NOT EXISTS "notifications" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_id_0" ON "notifications" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_notifications_userId_1" ON "notifications" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_notifications_type_2" ON "notifications" (json_extract(payload, '$.type') ASC);

CREATE INDEX IF NOT EXISTS "idx_notifications_isRead_3" ON "notifications" (json_extract(payload, '$.isRead') ASC);

CREATE INDEX IF NOT EXISTS "idx_notifications_created_at_4" ON "notifications" (json_extract(payload, '$.created_at') ASC);

CREATE TABLE IF NOT EXISTS "orders" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_orders_order_id_0" ON "orders" (json_extract(payload, '$.order_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_orders_idempotency_key_1" ON "orders" (json_extract(payload, '$.idempotency_key') ASC) WHERE json_type(payload, '$.idempotency_key') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_orders_user_id_2" ON "orders" (json_extract(payload, '$.user_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_orders_payment_payment_status_3" ON "orders" (json_extract(payload, '$.payment.payment_status') ASC);

CREATE INDEX IF NOT EXISTS "idx_orders_payment_payment_intent_id_4" ON "orders" (json_extract(payload, '$.payment.payment_intent_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_orders_fulfillment_status_5" ON "orders" (json_extract(payload, '$.fulfillment.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_orders_user_id_created_at_6" ON "orders" (json_extract(payload, '$.user_id') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_orders_fulfillment_status_created_at_7" ON "orders" (json_extract(payload, '$.fulfillment.status') ASC, json_extract(payload, '$.created_at') DESC);

CREATE INDEX IF NOT EXISTS "idx_orders_payment_payment_status_created_at_8" ON "orders" (json_extract(payload, '$.payment.payment_status') ASC, json_extract(payload, '$.created_at') DESC);

CREATE TABLE IF NOT EXISTS "otps" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_otps_login_0" ON "otps" (json_extract(payload, '$.login') ASC);

CREATE INDEX IF NOT EXISTS "idx_otps_expiresAt_1" ON "otps" (json_extract(payload, '$.expiresAt') ASC);

CREATE TABLE IF NOT EXISTS "patient_activity" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_patient_activity_id_0" ON "patient_activity" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_activity_userId_1" ON "patient_activity" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_activity_occurred_at_2" ON "patient_activity" (json_extract(payload, '$.occurred_at') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_activity_userId_occurred_at_3" ON "patient_activity" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.occurred_at') DESC);

CREATE TABLE IF NOT EXISTS "patient_care_events" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_patient_care_events_id_0" ON "patient_care_events" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_care_events_userId_1" ON "patient_care_events" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_care_events_userId_event_date_2" ON "patient_care_events" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.event_date') DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_patient_care_events_userId_event_date_event_type_event_key_3" ON "patient_care_events" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.event_date') ASC, json_extract(payload, '$.event_type') ASC, json_extract(payload, '$.event_key') ASC);

CREATE TABLE IF NOT EXISTS "products" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_products_id_0" ON "products" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_products_category_root_cause_1" ON "products" (json_extract(payload, '$.category') ASC, json_extract(payload, '$.root_cause') ASC);

CREATE INDEX IF NOT EXISTS "idx_products_status_created_at_2" ON "products" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.created_at') DESC);

CREATE TABLE IF NOT EXISTS "patient_progress_checkins" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_patient_progress_checkins_id_0" ON "patient_progress_checkins" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_progress_checkins_userId_1" ON "patient_progress_checkins" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_progress_checkins_date_2" ON "patient_progress_checkins" (json_extract(payload, '$.date') ASC);

CREATE INDEX IF NOT EXISTS "idx_patient_progress_checkins_userId_date_3" ON "patient_progress_checkins" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.date') DESC);

CREATE TABLE IF NOT EXISTS "provider_webhook_events" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_provider_webhook_events_provider_event_id_0" ON "provider_webhook_events" (json_extract(payload, '$.provider') ASC, json_extract(payload, '$.event_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_provider_webhook_events_status_updated_at_1" ON "provider_webhook_events" (json_extract(payload, '$.status') ASC, json_extract(payload, '$.updated_at') ASC);

CREATE TABLE IF NOT EXISTS "rate_limit_counters" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_rate_limit_counters_key_0" ON "rate_limit_counters" (json_extract(payload, '$.key') ASC);

CREATE INDEX IF NOT EXISTS "idx_rate_limit_counters_resetTime_1" ON "rate_limit_counters" (json_extract(payload, '$.resetTime') ASC);

CREATE TABLE IF NOT EXISTS "reviews" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_reviews_id_0" ON "reviews" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_reviews_review_type_1" ON "reviews" (json_extract(payload, '$.review_type') ASC);

CREATE INDEX IF NOT EXISTS "idx_reviews_status_2" ON "reviews" (json_extract(payload, '$.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_reviews_page_3" ON "reviews" (json_extract(payload, '$.page') ASC);

CREATE TABLE IF NOT EXISTS "auth_sessions" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_sessions_sessionId_0" ON "auth_sessions" (json_extract(payload, '$.sessionId') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_userId_1" ON "auth_sessions" (json_extract(payload, '$.userId') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_userType_2" ON "auth_sessions" (json_extract(payload, '$.userType') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_refreshTokenHash_3" ON "auth_sessions" (json_extract(payload, '$.refreshTokenHash') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_expiresAt_4" ON "auth_sessions" (json_extract(payload, '$.expiresAt') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_revokedAt_5" ON "auth_sessions" (json_extract(payload, '$.revokedAt') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_userId_revokedAt_6" ON "auth_sessions" (json_extract(payload, '$.userId') ASC, json_extract(payload, '$.revokedAt') ASC);

CREATE INDEX IF NOT EXISTS "idx_auth_sessions_expiresAt_7" ON "auth_sessions" (json_extract(payload, '$.expiresAt') ASC);

CREATE TABLE IF NOT EXISTS "support_inquiries" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_support_inquiries_id_0" ON "support_inquiries" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_support_inquiries_user_id_1" ON "support_inquiries" (json_extract(payload, '$.user_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_support_inquiries_status_2" ON "support_inquiries" (json_extract(payload, '$.status') ASC);

CREATE TABLE IF NOT EXISTS "treatments" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_treatments_id_0" ON "treatments" (json_extract(payload, '$.id') ASC);

CREATE INDEX IF NOT EXISTS "idx_treatments_test_id_1" ON "treatments" (json_extract(payload, '$.test_id') ASC);

CREATE INDEX IF NOT EXISTS "idx_treatments_reference_no_2" ON "treatments" (json_extract(payload, '$.reference_no') ASC);

CREATE INDEX IF NOT EXISTS "idx_treatments_userId_3" ON "treatments" (json_extract(payload, '$.userId') ASC);

CREATE TABLE IF NOT EXISTS "users" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_id_0" ON "users" (json_extract(payload, '$.id') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_phoneNormalized_1" ON "users" (json_extract(payload, '$.phoneNormalized') ASC) WHERE json_type(payload, '$.phoneNormalized') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_users_googleId_2" ON "users" (json_extract(payload, '$.googleId') ASC) WHERE json_type(payload, '$.googleId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_users_appleId_3" ON "users" (json_extract(payload, '$.appleId') ASC) WHERE json_type(payload, '$.appleId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_users_status_4" ON "users" (json_extract(payload, '$.status') ASC);

CREATE INDEX IF NOT EXISTS "idx_users_is_blocked_5" ON "users" (json_extract(payload, '$.is_blocked') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_6" ON "users" (json_extract(payload, '$.email') ASC) WHERE json_type(payload, '$.email') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_patient_code_7" ON "users" (json_extract(payload, '$.patient_code') ASC) WHERE json_type(payload, '$.patient_code') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_googleId_8" ON "users" (json_extract(payload, '$.googleId') ASC) WHERE json_type(payload, '$.googleId') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_appleId_9" ON "users" (json_extract(payload, '$.appleId') ASC) WHERE json_type(payload, '$.appleId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_users_role_created_at_id_10" ON "users" (json_extract(payload, '$.role') ASC, json_extract(payload, '$.created_at') DESC, json_extract(payload, '$.id') DESC);

CREATE TABLE IF NOT EXISTS "videos" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_videos_public_id_0" ON "videos" (json_extract(payload, '$.public_id') ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_videos_youtube_video_id_1" ON "videos" (json_extract(payload, '$.youtube_video_id') ASC) WHERE json_type(payload, '$.youtube_video_id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_videos_placement_2" ON "videos" (json_extract(payload, '$.placement') ASC);

CREATE INDEX IF NOT EXISTS "idx_videos_status_3" ON "videos" (json_extract(payload, '$.status') ASC);

CREATE TABLE IF NOT EXISTS "counters" (row_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_counters__id_0" ON "counters" (json_extract(payload, '$._id') ASC);
