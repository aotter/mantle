// Written once by `mantle generate`; this file is yours now. The Cloudflare entry (ADR-0032 decision 6).
import { waitUntil } from "cloudflare:workers";
import { toCloudflareCron } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";
import { mantle, type Env } from "./service.js";

// Cloudflare names a cron as wrangler.jsonc spells it; the plan's schedule Triggers are POSIX, and several spellings can share one
const crons = new Map<string, string[]>();
for (const t of Object.values(plan.triggers)) {
  if (t.source.kind !== "schedule" || t.source.enabled === false) continue;
  const cf = toCloudflareCron(t.source.cron);
  const posix = crons.get(cf) ?? [];
  if (!posix.includes(t.source.cron)) crons.set(cf, [...posix, t.source.cron]);
}
// not bound to one request, so a handler's ctx.waitUntil never lands on another request's finished context
const ctx = { waitUntil };

export default {
  fetch: (request, env) => mantle.fetch(request, env, ctx),
  async scheduled(controller, env) {
    const posix = crons.get(controller.cron);
    if (posix === undefined) throw new Error(`No schedule Trigger runs on the Cloudflare cron '${controller.cron}'`);
    const errors: unknown[] = [];
    for (const cron of posix) {
      try {
        await mantle.invokeSchedule(cron, controller.scheduledTime, env, ctx);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, `${errors.length} cron spelling(s) failed for '${controller.cron}'`);
  },
} satisfies ExportedHandler<Env>;
