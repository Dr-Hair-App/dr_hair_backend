# API and Cloudflare rollout

## Current architecture

| Layer | Current target |
| --- | --- |
| API runtime | Cloudflare Worker running the Express app |
| Durable records | D1, with per-domain tables, JSON payloads for nested records, and indexed lookup fields |
| Images and clinical documents | Private R2 bucket, accessed through authenticated API routes |
| Video content | YouTube URLs and streaming; video files are not uploaded |
| Public reads | Worker Cache API is used only for selected public catalog/content GETs; patient/admin data is not shared-cached |
| Notifications | Firebase Cloud Messaging, with device tokens and inbox records in D1 |

Dev and staging D1 databases are fresh; no MongoDB documents or media were imported. The production backend Worker and admin Worker respond on their `workers.dev` URLs. The custom `api.drhairindia.com` and `admin.drhairindia.com` hostnames did not resolve during the 2026-11-16 check. Production data should remain treated as a fresh setup unless an explicit seed/configuration has been applied.

## Implemented in the codebase

- D1-backed repositories cover accounts, authentication, clinical records, appointments, products, carts, addresses, inventory, orders, payments, webhooks, notifications, and admin settings.
- R2 storage handles image and private clinical-report uploads. Private reads use owner/admin authorization and short-lived signed API URLs.
- YouTube is the only video provider. Old Cloudinary upload, signature, video, and migration implementations are removed.
- Stock release is idempotent and batched in D1. Expired OTPs, sessions, and rate-limit counters are cleaned by a Worker cron trigger.
- Backend and admin GitHub Actions include checks and manual Cloudflare deployment workflows. Production deploys are gated.

## Remaining verification and hardening

1. Run the staging acceptance flow for admin authentication, API reads/writes, media access, Cashfree sandbox callbacks, simulated Shiprocket callbacks, and Flutter API compatibility.
2. Verify all production Worker secrets and the D1/R2 bindings from Cloudflare before relying on production transactions.
3. Restore the two custom domains by checking DNS records and Worker custom-domain routing.
4. Keep production deployment gated until staging acceptance passes.

See [`CLOUDFLARE_MIGRATION.md`](CLOUDFLARE_MIGRATION.md) for commands, bindings, and secret names. See [`openapi.yaml`](openapi.yaml) for the API contract; it should be kept aligned with the routes when those routes change.
