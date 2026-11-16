# API and Cloudflare rollout

## Current architecture

| Layer | Current target |
| --- | --- |
| API runtime | Cloudflare Worker running the Express app |
| Durable records | D1, with per-domain tables, JSON payloads for nested records, and indexed lookup fields |
| Images and clinical documents | Private R2 bucket, accessed through authenticated API routes |
| Video content | YouTube URLs and streaming; video files are not uploaded |
| Expiring public configuration | KV binding is reserved; no shared cache is used for patient/admin data |
| Notifications | Firebase Cloud Messaging, with device tokens and inbox records in D1 |

The dev and staging D1 databases are fresh and empty. The initial schema has been applied to both. No MongoDB documents or media have been imported. The production Worker and production storage/database resources are intentionally not provisioned as part of this development setup.

## Implemented in the codebase

- D1-backed repositories cover accounts, authentication, clinical records, appointments, products, carts, addresses, inventory, orders, payments, webhooks, notifications, and admin settings.
- R2 storage handles image and private clinical-report uploads. Private reads use owner/admin authorization and short-lived signed API URLs.
- YouTube is the only video provider. Old Cloudinary upload, signature, video, and migration implementations are removed.
- Stock release is idempotent and batched in D1. Expired OTPs, sessions, and rate-limit counters are cleaned by a Worker cron trigger.
- Backend and admin GitHub Actions include checks and manual Cloudflare deployment workflows. Production deploys are gated.

## Remaining before a usable live admin rollout

1. Connect Cloudflare Pages to `sunil2037/dr_hair_admin` and configure its Cloudflare build/runtime settings.
2. Deploy the backend Worker to the isolated staging environment and configure staging-only secrets for JWT/admin login, SMS, Razorpay test mode, Shiprocket sandbox, and optional notification/AI integrations.
3. Set the admin runtime's backend URL and allowed origin, then deploy and verify admin login, API reads/writes, media access, payment sandbox callbacks, shipping sandbox callbacks, and mobile API compatibility.
4. Set up Cloudflare/GitHub environment secrets for CI/CD. Keep production deployment disabled until the staging acceptance checks pass.

See [`CLOUDFLARE_MIGRATION.md`](CLOUDFLARE_MIGRATION.md) for commands, bindings, and secret names. See [`openapi.yaml`](openapi.yaml) for the API contract; it should be kept aligned with the routes when those routes change.
