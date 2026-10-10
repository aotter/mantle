import { describe, expect, it } from "vitest";
import * as mcpEntry from "../../src/mcp/index.js";
import * as specEntry from "../../src/spec/index.js";
import { compilePlan } from "../../src/spec/index.js";
import type { McpTool } from "../../src/mcp/index.js";

const manifests = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-item }
spec: { input: { type: object }, output: { type: object }, handler: { ref: add } }`;

describe("@aotter/mantle/mcp entry", () => {
  it("re-exports the same mcpTools as the spec entry", () => {
    expect(mcpEntry.mcpTools).toBe(specEntry.mcpTools);
  });

  it("lists tools for a plan", async () => {
    const result = await compilePlan({ sources: [{ sourceId: "mcp-entry", text: manifests }] });
    if (!result.ok) throw new Error("compile failed");
    const tools: McpTool[] = mcpEntry.mcpTools(result.plan, "public");
    expect(Array.isArray(tools)).toBe(true);
  });
});
