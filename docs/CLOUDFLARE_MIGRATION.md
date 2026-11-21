# Cloudflare setup

The backend runs as an Express-compatible Cloudflare Worker. D1 is the authoritative database, R2 stores uploaded images and private clinical documents, and video content uses YouTube streaming. There is no MongoDB, Cloudinary, Docker image, or Containers runtime in this setup. The initial D1 schema is empty; no MongoDB records or media are copied.

## Production and testing environments

The base `wrangler.jsonc` configuration targets the production Worker `dr-hair-backend`, custom domain `api.drhairindia.com`, and D1 database `dr-hair-production`. `ADMIN_MEDIA_BUCKET` points to the existing `dr-hair-production-media` bucket to retain catalog/content objects. `USER_MEDIA_BUCKET` points to `dr-hair-production-user-media` for patient-origin images, scalp/assessment images, and private clinical reports. `MEDIA_BUCKET` remains a production-only compatibility binding to the original bucket for legacy reads and cleanup. New media writes select the Admin or user bucket by authenticated owner/purpose.

The named `testing` environment uses Worker `dr-hair-backend-testing`, D1 `dr-hair-testing`, R2 buckets `dr-hair-testing-admin-media` and `dr-hair-testing-user-media`, and KV namespace `dr-hair-testing-public-config`. It intentionally omits `MEDIA_BUCKET`, Durable Object quota, and rate-limit bindings so testing cannot fall through to production storage or quota state.

For local development:

```sh
npm ci
npm run dev
npx wrangler d1 migrations apply dr-hair-testing --env testing --remote
```

`npm run dev` and `npm start` run the Worker locally with `--env testing`; the D1, R2, and KV bindings themselves use `remote: true`. Application data writes therefore persist only in the isolated testing resources and do not write D1/R2/KV data into `.wrangler/state` or production. The Worker runtime stays local, and testing has no Durable Object binding. Wrangler's `--remote` CLI option is not used because it would run the Worker remotely. Do not use `--local` for D1/R2/KV because that disables the remote test bindings. Provision the test resources before running these steps. Do not run the old Vercel/Render deployment commands; they were removed.

## Data and performance

- D1 tables retain each domain document in a JSON payload for nested clinical/order data. Indexed lookup, uniqueness, sort, and pagination fields have SQLite expression indexes declared in `migrations/0001_initial_schema.sql`.
- Use prepared D1 statements for all values. Do not construct SQL from request values. Keep patient, appointment, order, payment, inventory, session, OTP, and admin data authoritative in D1.
- Inventory release operations are idempotent and use a single D1 batch. OTP/session/rate-limit expiry cleanup runs on the Worker Cron Trigger.
- `PUBLIC_CONFIG_KV` carries optional usage-policy overrides only; an empty testing namespace uses application defaults. Do not use KV as a source of truth or shared cache, and do not move mutable inventory, payment, session, OTP, or patient/admin data to KV.
- R2 buckets are private. Admin catalog/content images use `ADMIN_MEDIA_BUCKET`; patient images, assessment photos, and clinical reports use `USER_MEDIA_BUCKET`. Public catalog media is served through the API; clinical images and reports require a short-lived HMAC-signed API URL. Reads and deletes check the appropriate new bucket first, then the legacy `MEDIA_BUCKET` only when that compatibility binding exists. Do not enable a public bucket or add patient-data caching.
- The media upload endpoint accepts images only. Admin videos are YouTube URLs and stream from YouTube; there is no video upload/storage route.

## Secrets and integrations

Add secrets to the production Worker with Wrangler or the Cloudflare dashboard. Required values include `JWT_SECRET`, Super Admin credentials, exact admin origin in `CORS_ORIGINS`, SMS/OTP provider configuration, Razorpay credentials and webhook secret, Shiprocket credentials and webhook secret, and optional Gemini/Firebase credentials. Local development uses local environment files and must not connect to production payment or shipping credentials.

Never put secrets in `wrangler.jsonc`, source control, the mobile app, or committed `.dev.vars`. The admin Worker must use its configured backend URL and keep API responses dynamic. No shared caching or image optimization is enabled for the admin panel.

## CI/CD and rollout

GitHub Actions runs backend checks and a Wrangler dry-run for pull requests and `main` pushes. Backend production deployment is explicit through `npm run deploy`; admin production deployment is a manual workflow dispatch from `main`:

```sh
gh workflow run cloudflare.yml --repo Dr-Hair-App/dr_hair_admin --ref main
```

Production custom domains are `https://api.drhairindia.com` and `https://admin.drhairindia.com`. Preserve production D1, the split Admin/user R2 bindings, their legacy media alias, and the production public-config KV namespace. Do not apply D1 migrations or change payment/shipping mode as part of resource cleanup; review those separately.
