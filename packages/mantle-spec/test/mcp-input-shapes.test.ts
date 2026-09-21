import { describe, expect, it } from "vitest";
import { parseManifests } from "./parse.js";
import { ValidateManifestsUseCase } from "../src/usecase/ValidateManifestsUseCase.js";

// Mirrors the mantle-home Cloud control plane shapes cited in #971.
const FIXTURE = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organizations }
spec:
  title: Organizations
  lifecycle: operational
  schema: { type: object, readOnly: true, properties: { name: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: cloud-upsert-organization }
spec:
  description: Save an organization.
  input:
    type: object
    additionalProperties: false
    required: [name]
    properties:
      name: { type: string }
      operationId: { type: string }
      id: { type: string }
      expectedVersion: { type: number }
    oneOf:
      - { type: object, required: [name, operationId], properties: { name: { type: string }, operationId: { type: string } } }
      - { type: object, required: [id, expectedVersion, name], properties: { id: { type: string }, expectedVersion: { type: number }, name: { type: string } } }
  output: { type: object }
  handler: { kind: builtin, op: upsert, schema: organizations }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: cloud-upsert-project }
spec:
  description: Save a project.
  input:
    type: object
    required: [name, document, sandbox]
    properties:
      name: { type: string }
      document: { type: object }
      sandbox: { type: array, maxItems: 5000, items: { type: object } }
      tags: { type: array, items: { type: string } }
      ids: { type: array, maxItems: 20, items: { type: string } }
      labels: { type: object, additionalProperties: { type: string } }
      notes: { type: [array, "null"], items: { type: string } }
  output: { type: object }
  handler: { kind: ref, ref: upsertProject }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: http-only-upsert }
spec:
  input:
    type: object
    oneOf:
      - { type: object, required: [a], properties: { a: { type: string } } }
      - { type: object, required: [b], properties: { b: { type: string } } }
  output: { type: object }
  handler: { kind: ref, ref: httpOnly }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: cloud-upsert-organization-member }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: cloud-upsert-organization }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: cloud-upsert-project-member }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: cloud-upsert-project }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: http-only-upsert-http }
spec:
  source: { kind: http, method: POST, path: /api/http-only }
  target: { procedure: http-only-upsert }
`;

function parsed() {
  const result = parseManifests(FIXTURE);
  if (!result.parsed) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result.parsed;
}

function shapes(options?: Parameters<typeof ValidateManifestsUseCase.run>[0]["mcpInput"]) {
  const response = ValidateManifestsUseCase.run({ parsed: parsed(), mcpInput: options });
  return response.diagnostics.filter((d) => d.code.startsWith("MCP_TOOL_INPUT_UN") && d.code !== "MCP_TOOL_INPUT_UNREACHABLE");
}

describe("MCP-surfaced input shape warnings (#971)", () => {
  it("warns on a top-level oneOf whose branches hide required fields, naming them", () => {
    const [union] = shapes().filter((d) => d.code === "MCP_TOOL_INPUT_UNION_AMBIGUOUS");
    expect(union).toMatchObject({
      severity: "warning",
      path: "/spec/input/oneOf",
      value: ["expectedVersion", "id", "operationId"],
    });
    expect(union?.message).toContain("cloud-upsert-organization");
    expect(union?.message).toContain("[name]");
    // The HTTP-only Procedure with the same shape stays silent.
    expect(shapes().some((d) => d.message.includes("http-only-upsert"))).toBe(false);
  });

  it("warns on unbounded arrays and free-form objects, not on bounded ones", () => {
    const unbounded = shapes().filter((d) => d.code === "MCP_TOOL_INPUT_UNBOUNDED").map((d) => d.path).sort();
    // `labels` is a typed map, not free-form; `notes` is array-or-null and still unbounded.
    expect(unbounded).toEqual([
      "/spec/input/properties/document",
      "/spec/input/properties/notes",
      "/spec/input/properties/sandbox",
      "/spec/input/properties/tags",
    ]);
  });

  it("lets a downstream tune or disable the checks through the request", () => {
    expect(shapes({ maxArrayItems: 5000 }).filter((d) => d.code === "MCP_TOOL_INPUT_UNBOUNDED").map((d) => d.path).sort())
      .toEqual(["/spec/input/properties/document", "/spec/input/properties/notes", "/spec/input/properties/tags"]);
    expect(shapes({ maxArrayItems: null }).filter((d) => d.code === "MCP_TOOL_INPUT_UNBOUNDED")).toEqual([]);
    expect(shapes({ unionAmbiguity: false }).filter((d) => d.code === "MCP_TOOL_INPUT_UNION_AMBIGUOUS")).toEqual([]);
    expect(shapes(false)).toEqual([]);
    const response = ValidateManifestsUseCase.run({ parsed: parsed() });
    expect(response.errorCount).toBe(0);
    expect(response.warningCount).toBeGreaterThan(0);
  });
});
