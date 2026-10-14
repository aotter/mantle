import { toCloudflareCron } from "@aotter/mantle/cron";
import type { Caller } from "@aotter/mantle/contracts";
import { store } from "../generated/generated.js";
import approvedRequests from "../generated/views/approved-requests.js";
import staleRequests from "../generated/views/stale-requests.js";
import { handlers } from "./handlers.js";
import { adminEmails, notify } from "./notify.js";
import { placeOrder } from "./supplier.js";

/** Daily 09:00 UTC; list the same expression in wrangler.jsonc `triggers.crons`. */
export const DAILY = toCloudflareCron("0 9 * * *");
/** Remind about requests still 'submitted' after this many days. */
const PENDING_DAYS = 3;

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron !== DAILY) throw new Error(`No application schedule runs on '${controller.cron}'`);
  const system: Caller = { kind: "system", reason: "daily purchasing cron" };

  // 1. Retry supplier orders that failed right after approval.
  const data = store(env.DB, system, { handlers });
  for (const { id, title, amount } of await approvedRequests(env.DB, system, {}))
    await placeOrder(data, { id: String(id), title: String(title), amount: Number(amount) }); // View rows are typed loosely

  // 2. Remind admins about requests waiting too long.
  const before = new Date(controller.scheduledTime - PENDING_DAYS * 86_400_000).toISOString();
  const stale = await staleRequests(env.DB, system, { before });
  if (stale.length === 0) return;
  const text = `${stale.length} purchase request(s) have waited more than ${PENDING_DAYS} days:\n` +
    stale.map(r => `- ${r.title} (${r.department}, ${r.amount})`).join("\n");
  for (const to of await adminEmails(env.DB)) await notify(to, "Purchase requests waiting for approval", text, "purchasing.reminder");
}
