import { toCloudflareCron } from "@aotter/mantle/cron";
import { weeklyDigest } from "./handlers.js";
import { fetchService } from "./service.js";
// Local `wrangler dev` (workerd) drops the connection when a request ends with its body unread, which fails the next
// request ("Network connection lost"). Rejections answer before reading the body, so drain what is left.
const fetch: ExportedHandlerFetchHandler<Env> = async (request, env, context) => {
  const response = await fetchService(request, env, context);
  if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => undefined);
  return response;
};
const cron = toCloudflareCron("0 3 * * 0");
export default {
  fetch,
  async scheduled(controller, env) {
    if (controller.cron !== cron) throw new Error(`No application schedule runs on '${controller.cron}'`);
    await weeklyDigest(env.DB, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
