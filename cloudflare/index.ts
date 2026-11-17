import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { runWithDatabaseBinding, setWorkerBindings } from "../src/shared/database/runtime.js";
import { setStorageBindings } from "../src/shared/storage/runtime.js";
import { processExpiredData } from "../src/shared/database/maintenance.js";

export { DailyUsageQuota } from "./DailyUsageQuota";

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
  if (runtimeEnv.MEDIA_BUCKET && typeof runtimeEnv.MEDIA_BUCKET.put === "function") {
    setStorageBindings(runtimeEnv);
  }
};

// Attach module bindings before route construction so shared D1-backed stores
// (including rate-limit stores) are initialized against the Worker database.
configureBindings(env);
const { app, container } = createApp();
app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });

const publicReadPath = (request: Request): boolean => {
  if (request.method !== "GET") return false;
  if (request.headers.has("authorization") || request.headers.has("cookie")) return false;
  const path = new URL(request.url).pathname;
  return [
    "/api/v1/categories",
    "/api/v1/products",
    "/api/v1/videos",
    "/api/v1/content",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
          expressHandler.fetch(request, requestEnv, ctx),
        );
      }
      return expressHandler.fetch(request, requestEnv, ctx);
    };

    if (!isPublicRead) return respond();

    return (async () => {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) {
        const headers = new Headers(cached.headers);
        const cacheControl = headers.get("Cache-Control");
        if (cacheControl) {
          headers.set("Cache-Control", cacheControl.replace(/max-age=\d+/, "max-age=0"));
        }
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
        ctx.waitUntil(cache.put(request, response.clone()));
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
