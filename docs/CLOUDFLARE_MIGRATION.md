# Cloudflare setup

The backend runs as an Express-compatible Cloudflare Worker. D1 is the authoritative database, R2 stores uploaded images and private clinical documents, and video content uses YouTube streaming. There is no MongoDB, Cloudinary, Docker image, or Containers runtime in this setup. The initial D1 schema is empty; no MongoDB records or media are copied.

## Single production Worker and local development

`wrangler.jsonc` targets one Cloudflare Worker named `dr-hair-backend`, with custom domain `api.drhairindia.com`, D1 `dr-hair-production`, R2 `dr-hair-production-media`, and the production public-config KV namespace. No persistent staging Worker or staging database is used. Local `wrangler dev` runs locally with isolated local bindings and development-only variables.

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

Add secrets to the production Worker with Wrangler or the Cloudflare dashboard. Required values include `JWT_SECRET`, Super Admin credentials, exact admin origin in `CORS_ORIGINS`, SMS/OTP provider configuration, Razorpay credentials and webhook secret, Shiprocket credentials and webhook secret, and optional Gemini/Firebase credentials. Local development uses local environment files and must not connect to production payment or shipping credentials.

Never put secrets in `wrangler.jsonc`, source control, the mobile app, or committed `.dev.vars`. The admin Worker must use its configured backend URL and keep API responses dynamic. No shared caching or image optimization is enabled for the admin panel.

## CI/CD and rollout

GitHub Actions runs backend checks and a Wrangler dry-run for pull requests and `main` pushes. Backend production deployment is explicit through `npm run deploy`; admin production deployment is a manual workflow dispatch from `main`:

```sh
gh workflow run cloudflare.yml --repo Dr-Hair-App/dr_hair_admin --ref main
```

Production custom domains are `https://api.drhairindia.com` and `https://admin.drhairindia.com`. Preserve the single production D1, R2, and KV resources. Do not apply D1 migrations or change payment/shipping mode as part of resource cleanup; review those separately.
