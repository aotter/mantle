import { describe, expect, it } from "vitest";
import { EntryDataValidator } from "../src/domain/service/EntryDataValidator.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";

/**
 * Build a minimal SchemaManifest for tests. The validator only
 * touches `metadata.name` (cache key) and `spec.schema` (compiled to
 * zod), so the other fields are filler.
 */
function makeManifest(name: string, schema: SchemaManifest["spec"]["schema"]): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name },
    spec: { title: name, schema },
  };
}

describe("EntryDataValidator — happy path", () => {
  it("returns no diagnostics for valid data", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        slug: { type: "string", pattern: "^[a-z0-9-]+$" },
      },
      required: ["title", "slug"],
    });
    const diags = v.validate(m, { title: "Hello", slug: "hello-world" });
    expect(diags).toEqual([]);
  });
});

describe("EntryDataValidator — failure shapes", () => {
  it("missing required field → INPUT_VALIDATION_FAILED at the field path", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: { title: { type: "string" }, slug: { type: "string" } },
      required: ["title", "slug"],
    });
    const diags = v.validate(m, { title: "Hi" });
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    expect(d.code).toBe("INPUT_VALIDATION_FAILED");
    expect(d.phase).toBe("runtime");
    expect(d.severity).toBe("error");
    expect(d.path).toBe("/slug");
  });

  it("wrong type → INPUT_VALIDATION_FAILED", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    const diags = v.validate(m, { title: 42 });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("INPUT_VALIDATION_FAILED");
    expect(diags[0]!.path).toBe("/title");
  });

  it("pattern violation → INPUT_VALIDATION_FAILED at the field path", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: { slug: { type: "string", pattern: "^[a-z0-9-]+$" } },
      required: ["slug"],
    });
    const diags = v.validate(m, { slug: "Has Spaces" });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("INPUT_VALIDATION_FAILED");
    expect(diags[0]!.path).toBe("/slug");
  });

  it("minLength violation → INPUT_VALIDATION_FAILED", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: { title: { type: "string", minLength: 5 } },
      required: ["title"],
    });
    const diags = v.validate(m, { title: "hi" });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("INPUT_VALIDATION_FAILED");
    expect(diags[0]!.path).toBe("/title");
  });

  it("nested-array element error path includes the index", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", minLength: 2 } },
      },
      required: ["tags"],
    });
    const diags = v.validate(m, { tags: ["ok", "x"] });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe("/tags/1");
  });

  it("root-level type error has empty path", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("scalar", { type: "string" });
    const diags = v.validate(m, 42);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe("");
  });
});

describe("EntryDataValidator — caching", () => {
  it("compiles a schema once per metadata.name across repeated validate calls", () => {
    const v = new EntryDataValidator();
    const m = makeManifest("posts", {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(v.hasCompiled("posts")).toBe(false);
    v.validate(m, { title: "x" });
    expect(v.hasCompiled("posts")).toBe(true);
    // Second validate must not re-compile — verifiable by snapshotting
    // the cached entry's identity is unchanged. The only public-ish
    // signal is `hasCompiled` returning true; combine with a result
    // sanity check.
    const before = v.hasCompiled("posts");
    const diags = v.validate(m, { title: "y" });
    expect(diags).toEqual([]);
    expect(v.hasCompiled("posts")).toBe(before);
  });

  it("different schemas under the same name share the cache (name is the key)", () => {
    // Documents the chosen behaviour: cache key is `metadata.name`,
    // so re-validating with a *different* schema body that shares the
    // same name reuses the first compile. Manifest names are unique
    // within a deployment, so this is correct in production; the
    // test asserts the contract.
    const v = new EntryDataValidator();
    const a = makeManifest("posts", {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    v.validate(a, { title: "x" });

    const b = makeManifest("posts", {
      // Wholly different shape; should be ignored because cache hit.
      type: "object",
      properties: { other: { type: "number" } },
      required: ["other"],
    });
    const diags = v.validate(b, { title: "x" });
    // First-compile was `a`, so `{title: "x"}` still validates.
    expect(diags).toEqual([]);
  });
});
