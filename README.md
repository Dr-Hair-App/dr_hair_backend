# Dr. Hair API

Express API for the Dr. Hair Flutter app and admin panel, deployed as a Cloudflare Worker. D1 is the durable database, R2 stores images and private clinical documents, and YouTube streams video content. No existing database or media records are imported into the fresh D1/R2 development environment.

## Local development

Requirements: Node.js 22 or later and npm.

```sh
npm ci
npm run dev
npx wrangler d1 migrations apply dr-hair-testing --env testing --local
```

`npm run dev` and `npm start` run the Worker locally with the `testing` environment and force `--local`. D1, R2, KV, and other bindings use Wrangler's local emulators and persist under `.wrangler/state`; these commands do not read or write remote testing resources or production. The `testing` environment still declares remote resources for deliberate staging acceptance, so keep `--local` in the normal dev scripts. Set `SHIPROCKET_STAGING_MODE=mock` to use the deterministic local simulator; it never calls Shiprocket's live API. The local environment has no production `MEDIA_BUCKET` compatibility binding, Durable Object binding, or rate-limit binding. Use only test accounts and test data. Remote test resources must be provisioned before a separately authorized remote acceptance run.

Shiprocket does not provide a separate API sandbox endpoint in its current API reference. `SHIPROCKET_TEST_MODE=true` is an explicit production-only simulator switch: it overrides live credentials and sends Shiprocket operations to the in-process mock. Keep it off during real fulfillment; simulated shipment IDs and AWBs must not be treated as carrier bookings. The default is `false`.

`npm run build:cloudflare` performs a Wrangler dry-run. `npm run deploy` targets the production Worker and its custom domain `api.drhairindia.com`; do not run it for routine local work.

The production D1 database is `dr-hair-production`. Create catalog, clinic, and admin configuration through the application/admin APIs. Do not seed historical production data. Migration `0004_admin_module_flags.sql` creates the initial admin navigation flags. Configure the first Super Admin ID and display name as Worker variables (`SUPER_ADMIN_ID`, `SUPER_ADMIN_NAME`). Generate its password hash with `npm run admin:setup`, then store it as the Worker secret `SUPER_ADMIN_PASSWORD_HASH` on `dr-hair-backend`. Never put the hash in `wrangler.jsonc` or commit it.

## Persistence and media

D1 is authoritative for users, appointments, assessments, treatments, products, carts, orders, payments, inventory, webhooks, notifications, and admin settings. Migrations are in `migrations/`. High-use fields have SQLite expression indexes; all D1 statements bind request values.

R2 buckets are private. `ADMIN_MEDIA_BUCKET` stores Admin-managed catalog and content images; in production it retains the existing `dr-hair-production-media` bucket so saved media remains available. `USER_MEDIA_BUCKET` stores patient-origin images, scalp/assessment images, and private clinical reports. `MEDIA_BUCKET` is a production-only legacy read/delete fallback for objects written before the split; new writes use the purpose-specific bucket. Testing uses separate Admin and user buckets without the legacy fallback. Public catalog images are served through the backend, while clinical photos and reports use short-lived signed URLs. Video upload/storage is disabled: admin video entries must use YouTube URLs and play through YouTube streaming. Admin and patient API data is not shared-cached. `PUBLIC_CONFIG_KV` stores optional usage-policy limits; an empty testing namespace uses application defaults.

## Worker secrets

Set secrets only in the intended Worker environment with Wrangler or the Cloudflare dashboard. Keep `JWT_SECRET`, Super Admin credentials, SMS/OTP credentials, `CASHFREE_App_ID`, `CASHFREE_KEY_SECRET`, and `CASHFREE_WEBHOOK_URL` out of source control; use separate sandbox credentials and callback endpoints for testing. New Cashfree checkout sessions use sandbox mode in this migration. Local development uses local bindings and keeps Shiprocket disabled.

## API routes and design

The OpenAPI contract is in [`docs/openapi.yaml`](docs/openapi.yaml). Swagger UI is served at `/api/docs`. Route groups include `/api/v1/auth`, `/api/v1/users`, `/api/v1/hair-tests`, `/api/v1/treatments`, `/api/v1/products`, `/api/v1/commerce`, `/api/v1/appointments`, `/api/v1/media`, `/api/v1/videos`, and `/api/v1/admin`.

Cloudflare bindings and the production-only deployment flow are documented in [`docs/CLOUDFLARE_MIGRATION.md`](docs/CLOUDFLARE_MIGRATION.md). Local code edits do not change live resources until the production deploy command is run.
