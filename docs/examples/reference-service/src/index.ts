import { toCloudflareCron } from "@aotter/mantle/cron";
import { weeklyDigest } from "./handlers.js";
import { fetchService } from "./service.js";
const cron = toCloudflareCron("0 3 * * 0");
export default {
  fetch: fetchService,
  async scheduled(controller, env) {
    if (controller.cron !== cron) throw new Error(`No application schedule runs on '${controller.cron}'`);
    await weeklyDigest(env.DB, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
