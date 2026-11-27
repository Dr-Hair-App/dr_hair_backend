import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { runWithDatabaseBinding, setWorkerBindings } from "../src/shared/database/runtime.js";
import { setStorageBindings } from "../src/shared/storage/runtime.js";
import { processExpiredData } from "../src/shared/database/maintenance.js";
import { runWithExecutionContext } from "../src/shared/runtime/execution-context.js";

export { DailyUsageQuota } from "./DailyUsageQuota.ts";

const configureBindings = (runtimeEnv: typeof env): void => {
  // Populate process.env with runtimeEnv secrets and variables so express modules can access them
  if (runtimeEnv && typeof runtimeEnv === "object") {
    for (const [key, val] of Object.entries(runtimeEnv)) {
      if (typeof val === "string") {
        process.env[key] = val;
      }
    }
  }
  // Cloudflare's deployment validator evaluates the module without resource
  // bindings. Attach bindings at request time, when the live Worker env exists.
  if (runtimeEnv.DB && typeof runtimeEnv.DB.prepare === "function") {
    setWorkerBindings(runtimeEnv);
  }
  if (
    (runtimeEnv.MEDIA_BUCKET && typeof runtimeEnv.MEDIA_BUCKET.put === "function") ||
    (runtimeEnv.ADMIN_MEDIA_BUCKET && typeof runtimeEnv.ADMIN_MEDIA_BUCKET.put === "function") ||
    (runtimeEnv.USER_MEDIA_BUCKET && typeof runtimeEnv.USER_MEDIA_BUCKET.put === "function")
  ) {
    setStorageBindings(runtimeEnv);
  }
};

// Attach module bindings before route construction so shared D1-backed stores
// (including rate-limit stores) are initialized against the Worker database.
configureBindings(env);
const { app, container } = createApp();
app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });

const PUBLIC_PREFIXES = [
  "/api/v1/categories",
  "/categories",
  "/api/v1/products",
  "/products",
  "/api/v1/videos",
  "/api/v1/content",
  "/policies",
  "/faqs",
  "/stories",
  "/tips",
  "/services",
  "/api/v1/services",
  "/api/v1/reviews",
  "/Review/review_get",
  "/review/review_get",
];

const PUBLIC_EXACT_PATHS = [
  "/api/v1/app/config",
  "/api/v1/app/version",
  "/api/v1/appointments/closed-dates",
  "/api/v1/appointments/availability",
  "/api/v1/commerce/coupons",
];

export const publicReadPath = (request: Request): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return true;
  }
  if (PUBLIC_EXACT_PATHS.includes(path)) {
    return true;
  }
  if (path.startsWith("/api/v1/media/assets/") && !url.searchParams.has("sig")) {
    return true;
  }
  return false;
};

export const createCacheKey = (request: Request): Request => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return new Request(url.toString(), {
    method: "GET",
    headers,
  });
};

const CATALOG_CACHE_VERSION_KEY = "catalog_cache_version";
const CATALOG_CACHE_VERSION_TTL_MS = 10_000;

let cachedCatalogVersion: string | null = null;
let cachedCatalogVersionExpiresAt = 0;
let inFlightCatalogVersionRead: Promise<string | null> | null = null;

export const getCatalogCacheVersion = async (requestEnv: typeof env): Promise<string | null> => {
  const now = Date.now();
  if (now < cachedCatalogVersionExpiresAt) {
    return cachedCatalogVersion;
  }

  const kv = requestEnv?.PUBLIC_CONFIG_KV;
  if (!kv || typeof kv.get !== "function") {
    return cachedCatalogVersion;
  }

  if (!inFlightCatalogVersionRead) {
    inFlightCatalogVersionRead = kv
      .get(CATALOG_CACHE_VERSION_KEY)
      .then((value) => {
        const normalized = typeof value === "string" && value.trim() ? value.trim() : null;
        cachedCatalogVersion = normalized;
        cachedCatalogVersionExpiresAt = Date.now() + CATALOG_CACHE_VERSION_TTL_MS;
        return normalized;
      })
      .catch(() => {
        cachedCatalogVersionExpiresAt = Date.now() + CATALOG_CACHE_VERSION_TTL_MS;
        return cachedCatalogVersion;
      })
      .finally(() => {
        inFlightCatalogVersionRead = null;
      });
  }

  return inFlightCatalogVersionRead;
};

export const createVersionedCacheKey = (request: Request, cacheVersion?: string | null): Request => {
  const baseKey = createCacheKey(request);
  if (!cacheVersion) return baseKey;
  const url = new URL(baseKey.url);
  url.searchParams.set("_cv", cacheVersion);
  return new Request(url.toString(), {
    method: baseKey.method,
    headers: baseKey.headers,
  });
};

export default {
  ...expressHandler,

  fetch(request: Request, requestEnv: typeof env, ctx: ExecutionContext): Promise<Response> {
    configureBindings(requestEnv);
    const database = requestEnv.DB;
    const isPublicRead = publicReadPath(request);

    const respond = () => {
      if (isPublicRead && database && typeof database.withSession === "function") {
        return runWithDatabaseBinding(database.withSession("first-unconstrained"), () =>
          runWithExecutionContext(ctx, () => expressHandler.fetch!(request as any, requestEnv, ctx)),
        );
      }
      return runWithExecutionContext(ctx, () => expressHandler.fetch!(request as any, requestEnv, ctx));
    };

    if (!isPublicRead) return respond();

    return (async () => {
      const cache = typeof caches !== "undefined" ? caches.default : null;
      if (!cache) return respond();

      const cacheVersion = await getCatalogCacheVersion(requestEnv);
      const cacheKey = createVersionedCacheKey(request, cacheVersion);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const clientEtag = request.headers.get("if-none-match");
        const cachedEtag = cached.headers.get("etag");
        if (clientEtag && cachedEtag) {
          const targetEtag = cachedEtag.replace(/^W\//, "").trim();
          const isMatch = clientEtag.split(",").some((token) => {
            const clean = token.trim();
            return clean === "*" || clean === cachedEtag || clean.replace(/^W\//, "") === targetEtag;
          });
          if (isMatch) {
            return new Response(null, {
              status: 304,
              statusText: "Not Modified",
              headers: new Headers(cached.headers),
            });
          }
        }

        const headers = new Headers(cached.headers);
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }

      const response = await respond();
      const cacheControl = response.headers.get("Cache-Control") || "";
      if (
        response.status === 200 &&
        cacheControl.includes("public") &&
        !response.headers.has("Set-Cookie")
      ) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    })();
  },

  scheduled(_controller: ScheduledController, scheduledEnv: typeof env, ctx: ExecutionContext): void {
    configureBindings(scheduledEnv);
    const cronSecret = (scheduledEnv as typeof env & { CRON_SECRET?: string }).CRON_SECRET;
    const jobs = [
      container.useCases.processQueuedAiAssessmentUseCase.processOne(),
      processExpiredData(scheduledEnv.DB),
      container.repositories.adminApiTrafficRepository.purgeExpired(),
      container.services.campaignSchedulerService.processDueCampaigns(),
      cronSecret
        ? container.controllers.commerceController.reconcilePendingCheckoutsScheduled()
        : Promise.resolve(),
    ];
    ctx.waitUntil(Promise.allSettled(jobs).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          const error = result.reason as { name?: string; code?: string };
          console.error("Scheduled maintenance job failed", error?.code || error?.name || "unknown_error");
        }
      }
    }));
  },
};
