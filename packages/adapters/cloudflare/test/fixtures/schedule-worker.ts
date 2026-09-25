import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { createSetupIncompleteAuth } from "../../src/auth/createAuth.js";
import { createMantleWorker } from "../../src/worker/createMantleWorker.js";

const text = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: scheduled-tick }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: tick }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: daily-tick }
spec:
  source: { kind: schedule, cron: "0 2 * * *" }
  target: { procedure: scheduled-tick }
`;
const parsed = parseManifestSources({ sources: [{ sourceId: "schedule-worker", text }] });
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const linked = linkManifestSet(parsed.value);
if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
const compiled = compileRuntimePlan(linked.value);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
const seen: string[] = [];
const worker = createMantleWorker({
  plan: compiled.value,
  surfaces: { api: false, mcp: false, admin: false },
  auth: () => createSetupIncompleteAuth({ message: "test" }),
  handlers: { tick: (_input, ctx) => {
    seen.push(ctx.schedule?.id ?? "missing");
    return {};
  } },
});

export default {
  fetch: () => Response.json({ seen }),
  scheduled: worker.scheduled,
};
