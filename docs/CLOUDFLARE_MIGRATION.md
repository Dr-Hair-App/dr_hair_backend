# Cloudflare setup

The backend runs as an Express-compatible Cloudflare Worker. D1 is the authoritative database, R2 stores uploaded images and private clinical documents, and video content uses YouTube streaming. There is no MongoDB, Cloudinary, Docker image, or Containers runtime in this setup. The initial D1 schema is empty; no MongoDB records or media are copied.

## Development resources

`wrangler.jsonc` declares separate local/development, staging, and production bindings. The default Worker is `dr-hair-backend` with D1 `dr-hair-dev` and R2 `dr-hair-dev-media`. Staging and production use separate database and bucket names. Apply SQL migrations only to the selected environment. Do not configure production credentials in the development Worker.

For local development:

```sh
npm ci
npm run dev
npx wrangler d1 migrations apply dr-hair-dev --local
```

Local D1, R2, and KV state is isolated under Wrangler's local state directory. No `--remote` command is used by these steps. `npm start` uses the same Worker runtime through Wrangler. Do not run the old Vercel/Render deployment commands; they were removed.

## Data and performance

- D1 tables retain each domain document in a JSON payload for nested clinical/order data. Indexed lookup, uniqueness, sort, and pagination fields have SQLite expression indexes declared in `migrations/0001_initial_schema.sql`.
- Use prepared D1 statements for all values. Do not construct SQL from request values. Keep patient, appointment, order, payment, inventory, session, OTP, and admin data authoritative in D1.
- Inventory release operations are idempotent and use a single D1 batch. OTP/session/rate-limit expiry cleanup runs on the Worker Cron Trigger.
- KV is bound but is not used as a source of truth or shared cache. Patient/admin data stays uncached. Do not move mutable inventory, payment, session, or OTP state to KV.
- R2 is private. Public catalog media is served through the API; clinical images and reports require a short-lived HMAC-signed API URL. Do not enable a public bucket or add patient-data caching.
- The media upload endpoint accepts images only. Admin videos are YouTube URLs and stream from YouTube; there is no video upload/storage route.

## Secrets and integrations

Add secrets to the selected Worker environment with Wrangler/GitHub Environment secrets. Required values include `JWT_SECRET`, Super Admin credentials, exact admin origin in `CORS_ORIGINS`, SMS/OTP provider configuration, Razorpay test credentials and webhook secret, Shiprocket live credentials and webhook secret only in production, and optional Gemini/Firebase credentials. Shiprocket documents a live API endpoint rather than a separate sandbox: staging must use `DRHAIR_DEPLOYMENT_ENV=staging` and `SHIPROCKET_STAGING_MODE=mock`, with no Shiprocket live credentials configured.

Never put secrets in `wrangler.jsonc`, source control, the mobile app, or committed `.dev.vars`. The admin Worker must use its configured backend URL and keep API responses dynamic. No shared caching or image optimization is enabled for the admin panel.

## CI/CD and rollout

GitHub Actions runs backend tests and a Wrangler dry-run for pull requests and `main` pushes. Deployment is a separate manual dispatch from `main`:

```sh
gh workflow run cloudflare.yml --repo sunil2037/dr_hair_backend --ref main -f target=staging
```

Production deploy remains gated by the explicit `CLOUDFLARE_PRODUCTION_DEPLOY_ENABLED=true` environment variable. Do not bypass the gate with a manual production upload.

### Staging verification (2026-11-17)

- Backend: `https://dr-hair-backend-staging.drhair-app.workers.dev`; `/health` returned HTTP 200 with D1 connected.
- Admin: `https://dr-hair-admin-staging.drhair-app.workers.dev`; the root returned HTTP 200, and the admin login/session proxy completed successfully.
- Staging D1 is fresh: `users`, `orders`, and `clinic_appointments` each contain zero rows. No production records or media were imported.
- Razorpay test credentials authenticated successfully against the Razorpay test API. Shiprocket has no separate supported API sandbox, so staging uses `SHIPROCKET_STAGING_MODE=mock` and contains no Shiprocket credentials. The simulator covers quotes, pickup, tracking, and shipment actions without reaching Shiprocket.
- Verification passed: backend tests (346), backend Wrangler dry-run, Admin lint/build, Flutter analyze and tests (282). Staging login/session, app-config, feature/release reads, and health checks were also verified over HTTP.

### Production readiness

The current production backend and Admin URLs responded with HTTP 200 on 2026-11-17, but they still run the previous deployment. Production is not updated by the staging rollout. The production Worker is missing `SUPER_ADMIN_PASSWORD_HASH`, `SHIPROCKET_API_EMAIL`, and `SHIPROCKET_API_PASSWORD`; set the intended Super Admin password hash before deploying the new backend. Configure a Shiprocket API user only when live shipping is approved; valid Shiprocket API calls affect the real account. Keep the production GitHub deployment gate disabled until credentials and live-payment/shipping behavior have been reviewed.
