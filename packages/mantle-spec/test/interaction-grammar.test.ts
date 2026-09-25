import { describe, expect, it } from "vitest";
import {
  requiredMantleRefFields,
  resolveMantleRef,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
} from "../src/index.js";
import { parseManifests, validateManifests } from "./parse.js";

/** ADR-0029 D4: `x-mantle-ref` object form and `Procedure.spec.target`. */

const apiVersion = "cms.mantle.aotter.net/v1" as const;

function requisitions(): SchemaManifest {
  return {
    apiVersion,
    kind: "Schema",
    metadata: { name: "requisitions" },
    spec: {
      title: "Requisitions",
      lifecycle: "operational",
      uniqueIndexes: [["requestNumber"]],
      schema: {
        type: "object",
        properties: { requestNumber: { type: "string" }, item: { type: "string" } },
        required: ["requestNumber"],
      },
    },
  };
}

function review(spec: Partial<ProcedureManifest["spec"]> = {}): ProcedureManifest {
  return {
    apiVersion,
    kind: "Procedure",
    metadata: { name: "review" },
    spec: {
      input: {
        type: "object",
        properties: {
          requisitionId: { type: "string", "x-mantle-ref": { schema: "requisitions", field: "id" } },
          expectedVersion: { type: "integer" },
          decision: { type: "string" },
        },
        required: ["requisitionId", "expectedVersion"],
      },
      output: { type: "object" },
      handler: { kind: "ref", ref: "review" },
      target: { schema: "requisitions", id: "requisitionId", version: "expectedVersion" },
      ...spec,
    } as ProcedureManifest["spec"],
  };
}

function errors(manifests: Manifest[]) {
  return validateManifests({ manifests }).diagnostics.filter((d) => d.severity === "error");
}

describe("resolveMantleRef", () => {
  it("normalizes the string form to an id reference and passes the object form through", () => {
    expect(resolveMantleRef({ "x-mantle-ref": "posts" })).toEqual({ schema: "posts", field: "id" });
    expect(resolveMantleRef({ "x-mantle-ref": { schema: "posts", field: "slug" } })).toEqual({ schema: "posts", field: "slug" });
  });

  it.each([[{}], [{ "x-mantle-ref": "" }], [{ "x-mantle-ref": { schema: "posts" } }], [{ "x-mantle-ref": ["posts"] }], [null]])(
    "returns null for %j",
    (property) => expect(resolveMantleRef(property)).toBeNull(),
  );
});

describe("x-mantle-ref object form", () => {
  it("accepts id and a single-field unique index as the target field", () => {
    const byNumber = review();
    const input = byNumber.spec.input.properties!;
    const manifests = [
      requisitions(),
      review(),
      {
        ...byNumber,
        metadata: { name: "lookup" },
        spec: {
          ...byNumber.spec,
          target: undefined,
          input: {
            ...byNumber.spec.input,
            properties: { ...input, requisitionId: { type: "string", "x-mantle-ref": { schema: "requisitions", field: "requestNumber" } } },
          },
        },
      } as ProcedureManifest,
    ];
    expect(errors(manifests)).toEqual([]);
  });

  it.each([
    [{ schema: "requisitions", field: "item" }, "/field", "does not identify one entry"],
    [{ schema: "requisition", field: "id" }, "/schema", "unknown Schema"],
    [{ schema: "requisitions" }, "", "malformed"],
    [{ schema: "requisitions", field: "id", extra: true }, "", "malformed"],
  ])("rejects %j", (ref, suffix, message) => {
    const procedure = review({ target: undefined });
    const properties = { ...procedure.spec.input.properties!, requisitionId: { type: "string", "x-mantle-ref": ref } };
    const found = errors([requisitions(), { ...procedure, spec: { ...procedure.spec, input: { ...procedure.spec.input, properties } } } as ProcedureManifest]);
    expect(found).toEqual([expect.objectContaining({
      code: "MANTLE_REF_INVALID",
      path: expect.stringContaining(`/spec/input/properties/requisitionId/x-mantle-ref${suffix}`),
      message: expect.stringContaining(message),
    })]);
  });

  it("validates Schema properties and keeps parent scopes to id references", () => {
    const lines = (ref: unknown): SchemaManifest => ({
      apiVersion,
      kind: "Schema",
      metadata: { name: "lines" },
      spec: {
        title: "Lines",
        schema: { type: "object", properties: { parent: { type: "string", "x-mantle-ref": ref } }, required: ["parent"] },
      },
    } as SchemaManifest);
    expect(errors([requisitions(), lines({ schema: "requisitions", field: "item" })]))
      .toEqual([expect.objectContaining({ code: "MANTLE_REF_INVALID" })]);
    expect(requiredMantleRefFields(lines({ schema: "requisitions", field: "id" })))
      .toEqual([{ field: "parent", collection: "requisitions" }]);
    expect(requiredMantleRefFields(lines({ schema: "requisitions", field: "requestNumber" }))).toEqual([]);
    expect(requiredMantleRefFields(lines("requisitions"))).toEqual([{ field: "parent", collection: "requisitions" }]);
  });
});

describe("Procedure.spec.target", () => {
  it("accepts a ref handler target over a required string id and a number version", () => {
    expect(errors([requisitions(), review()])).toEqual([]);
  });

  it.each([
    [{ target: { schema: "nope", id: "requisitionId" } }, "/spec/target/schema"],
    [{ target: { schema: "requisitions", id: "decision" } }, "/spec/target/id"],
    [{ target: { schema: "requisitions", id: "requisitionId", version: "decision" } }, "/spec/target/version"],
    [{ handler: { kind: "builtin", op: "update", schema: "requisitions" } }, "/spec/target"],
  ])("rejects %j", (spec, pointer) => {
    const found = errors([requisitions(), review(spec as Partial<ProcedureManifest["spec"]>)]);
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "PROCEDURE_TARGET_INVALID",
      path: expect.stringMatching(new RegExp(`${pointer}$`)),
    })]));
  });

  it.each([[{ schema: "requisitions" }], [{ schema: "requisitions", id: "" }], ["requisitions"], [{ schema: "r", id: "i", lock: "v" }]])(
    "rejects the malformed shape %j at parse time",
    (target) => {
      const doc = `apiVersion: ${apiVersion}
kind: Procedure
metadata: { name: review }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: review }
  target: ${JSON.stringify(target)}
`;
      const { diagnostics } = parseManifests(doc);
      expect(diagnostics[0]?.path).toContain("/spec/target");
    },
  );
});
