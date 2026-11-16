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

Add secrets to the selected Worker environment with Wrangler/GitHub Environment secrets. Required values include `JWT_SECRET`, Super Admin credentials, exact admin origin in `CORS_ORIGINS`, SMS/OTP provider configuration, Razorpay test credentials and webhook secret, Shiprocket sandbox credentials and webhook secret, and optional Gemini/Firebase credentials. Use `DRHAIR_DEPLOYMENT_ENV=staging` for staging so payment and shipping integrations remain in test/sandbox mode.

Never put secrets in `wrangler.jsonc`, source control, the mobile app, or committed `.dev.vars`. The admin Worker must use its configured backend URL and keep API responses dynamic. No shared caching or image optimization is enabled for the admin panel.

## CI/CD and rollout

GitHub Actions runs backend tests and a Wrangler dry-run for pull requests and `main` pushes. Deployment is a separate manual dispatch. Staging deploys to `dr-hair-backend-staging` only. Production deploy remains gated by the explicit `CLOUDFLARE_PRODUCTION_DEPLOY_ENABLED=true` environment variable.

The Cloudflare account has isolated dev and staging D1, R2 and KV resources. The initial schema has been applied to the empty dev and staging databases; no legacy records or media were imported. The `drhair-admin` Pages project exists, but its production configuration currently has no Git source, environment variables, or successful deployment. Wrangler CLI is not authenticated in this workspace, so a Worker deployment still needs an authenticated Cloudflare CI/CD run. Production backend bindings intentionally remain unprovisioned.
