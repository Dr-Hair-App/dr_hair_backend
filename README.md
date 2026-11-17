# Dr. Hair API

Express API for the Dr. Hair Flutter app and admin panel, deployed as a Cloudflare Worker. D1 is the durable database, R2 stores images and private clinical documents, and YouTube streams video content. No existing database or media records are imported into the fresh D1/R2 development environment.

## Local development

Requirements: Node.js 22 or later and npm.

```sh
npm ci
npm run dev
npx wrangler d1 migrations apply dr-hair-dev --local
```

Wrangler local development uses local D1, R2, and KV emulators. `npm run build:cloudflare` performs a Wrangler dry-run. `npm run deploy` targets the single production Worker `dr-hair-backend` and its custom domain `api.drhairindia.com`; do not run it for routine local work.

The production D1 database is `dr-hair-production`. Create catalog, clinic, and admin configuration through the application/admin APIs. Do not seed historical production data. Migration `0004_admin_module_flags.sql` creates the initial admin navigation flags. Configure the first Super Admin ID and display name as Worker variables (`SUPER_ADMIN_ID`, `SUPER_ADMIN_NAME`). Generate its password hash with `npm run admin:setup`, then store it as the Worker secret `SUPER_ADMIN_PASSWORD_HASH` on `dr-hair-backend`. Never put the hash in `wrangler.jsonc` or commit it.

## Persistence and media

D1 is authoritative for users, appointments, assessments, treatments, products, carts, orders, payments, inventory, webhooks, notifications, and admin settings. Migrations are in `migrations/`. High-use fields have SQLite expression indexes; all D1 statements bind request values.

The R2 bucket is private. Image uploads use `/api/v1/media/upload`; public catalog images are served through the backend, while clinical photos and reports use short-lived signed URLs. Video upload/storage is disabled: admin video entries must use YouTube URLs and play through YouTube streaming. Admin and patient API data is not shared-cached. The public config KV binding is reserved and currently unused.

## Worker secrets

Set production secrets on the single `dr-hair-backend` Worker with Wrangler or the Cloudflare dashboard. Keep `JWT_SECRET`, Super Admin credentials, SMS/OTP credentials, Razorpay keys and webhook secret, Shiprocket credentials and webhook secret, and optional Gemini/Firebase keys out of source control. Local development uses local bindings and keeps Shiprocket disabled.

## API routes and design

The OpenAPI contract is in [`docs/openapi.yaml`](docs/openapi.yaml). Swagger UI is served at `/api/docs`. Route groups include `/api/v1/auth`, `/api/v1/users`, `/api/v1/hair-tests`, `/api/v1/treatments`, `/api/v1/products`, `/api/v1/commerce`, `/api/v1/appointments`, `/api/v1/media`, `/api/v1/videos`, and `/api/v1/admin`.

Cloudflare bindings and the production-only deployment flow are documented in [`docs/CLOUDFLARE_MIGRATION.md`](docs/CLOUDFLARE_MIGRATION.md). Local code edits do not change live resources until the production deploy command is run.
