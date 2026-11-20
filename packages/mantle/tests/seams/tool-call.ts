/** Required application seam `tool-call-signal-progress` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import type { Tool, ToolCall } from "@aotter/mantle/mcp";

export const steps: Tool<unknown> = {
  name: "seam_steps",
  surface: "public",
  description: "Steps.",
  inputSchema: { type: "object", additionalProperties: false },
  validate: () => ({}),
  run: async (_db, _caller, _input, _handlers, call: ToolCall) => {
    for (let step = 1; step <= 2; step++) {
      call.signal?.throwIfAborted();
      await call.progress?.(step, 2, `step ${step}`);
    }
    return { steps: 2 };
  },
};
