import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { setWorkerBindings } from "../src/shared/database/runtime.js";
import { setStorageBindings } from "../src/shared/storage/runtime.js";
import { processExpiredData } from "../src/shared/database/maintenance.js";

const configureBindings = (runtimeEnv: typeof env): void => {
  // Cloudflare's deployment validator evaluates the module without resource
  // bindings. Attach bindings at request time, when the live Worker env exists.
  if (runtimeEnv.DB && typeof runtimeEnv.DB.prepare === "function") {
    setWorkerBindings(runtimeEnv);
  }
  if (runtimeEnv.MEDIA_BUCKET && typeof runtimeEnv.MEDIA_BUCKET.put === "function") {
    setStorageBindings(runtimeEnv);
  }
};

const { app, container } = createApp();
app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });
configureBindings(env);

export default {
  ...expressHandler,

  scheduled(_controller: ScheduledController, scheduledEnv: typeof env, ctx: ExecutionContext): void {
    configureBindings(scheduledEnv);
    ctx.waitUntil(Promise.all([
      container.useCases.processQueuedAiAssessmentUseCase.processOne(),
      processExpiredData(scheduledEnv.DB),
    ]).then(() => undefined));
  },
};
