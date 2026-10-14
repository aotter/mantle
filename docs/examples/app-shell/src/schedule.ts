/**
 * Scheduled work is app code: list each cron in wrangler.jsonc `triggers.crons` and branch on `controller.cron`
 * (`toCloudflareCron` from "@aotter/mantle/cron" converts a standard expression).
 * AGENT: call the Store or a generated Procedure here; schedules are not manifest Triggers.
 */
export async function scheduled(controller: ScheduledController, _env: Env): Promise<void> {
  throw new Error(`No application schedule runs on '${controller.cron}'`);
}
