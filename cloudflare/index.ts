import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { setWorkerBindings } from "../src/shared/database/runtime.js";
import { setStorageBindings } from "../src/shared/storage/runtime.js";
import { processExpiredData } from "../src/shared/database/maintenance.js";

setWorkerBindings(env);
setStorageBindings(env);

const { app, container } = createApp();
app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });

export default {
  fetch(request: Request): Promise<Response> {
    return expressHandler.fetch(request);
  },

  scheduled(_controller: ScheduledController, scheduledEnv: typeof env, ctx: ExecutionContext): void {
    setWorkerBindings(scheduledEnv);
    setStorageBindings(scheduledEnv);
    ctx.waitUntil(Promise.all([
      container.useCases.processQueuedAiAssessmentUseCase.processOne(),
      processExpiredData(scheduledEnv.DB),
    ]).then(() => undefined));
  },
};
