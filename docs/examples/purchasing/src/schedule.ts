import { toCloudflareCron } from "@aotter/mantle/cron";
import staleRequests from "../generated/views/stale-requests.js";
import { adminEmails, notify } from "./notify.js";

/** Daily 09:00 UTC; list the same expression in wrangler.jsonc `triggers.crons`. */
export const DAILY_REMINDER = toCloudflareCron("0 9 * * *");
/** Remind about requests still 'submitted' after this many days. */
const PENDING_DAYS = 3;

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron !== DAILY_REMINDER) throw new Error(`No application schedule runs on '${controller.cron}'`);
  const before = new Date(controller.scheduledTime - PENDING_DAYS * 86_400_000).toISOString();
  const stale = await staleRequests(env.DB, { kind: "system", reason: "pending reminder" }, { before });
  if (stale.length === 0) return;
  const text = `${stale.length} purchase request(s) have waited more than ${PENDING_DAYS} days:\n` +
    stale.map(r => `- ${r.title} (${r.department}, ${r.amount})`).join("\n");
  for (const to of await adminEmails(env.DB)) await notify(to, "Purchase requests waiting for approval", text, "purchasing.reminder");
}
