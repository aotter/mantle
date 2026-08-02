import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGenerate } from "../src/generate.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("mantle generate", () => {
  it("emits typed handlers and a typed View runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-test-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), `
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  schema:
    type: object
    properties: { slug: { type: string }, title: { type: string } }
  lifecycle: simple
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: public-products }
spec:
  from: products
  fields: [id, slug, title]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: refresh-catalog }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: refreshCatalog }
`);
      process.chdir(root);

      expect(await runGenerate(["--no-skills"])).toBe(0);

      const site = await readFile(join(root, ".mantle", "generated", "site.ts"), "utf8");
      const types = await readFile(join(root, ".mantle", "generated", "types.d.ts"), "utf8");
      expect(site).toContain("export function bindMantleSite(runtime: CmsRuntime)");
      expect(site).toContain('readonly "public-products"');
      expect(site).toContain("MantleSite.ViewRow_public_products");
      // Keep this as an object type alias. Unlike an interface, it remains
      // assignable to the façade's Record<string, AnyHandler> registry while
      // preserving exact generated keys and contextual handler types.
      expect(types).toContain("export type MantleHandlers<Env = unknown> = {");
      expect(types).not.toContain("export interface MantleHandlers");
      expect(types).toContain("MantleSite.ProcOutput_refresh_catalog, Env>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits one union handler when Procedures share a handler ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-shared-handler-test-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), `
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: import-product }
spec:
  input: { type: object, properties: { sku: { type: string } } }
  output: { type: object, properties: { imported: { type: boolean } } }
  handler: { kind: ref, ref: syncCatalog }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: remove-product }
spec:
  input: { type: object, properties: { id: { type: string } } }
  output: { type: object, properties: { removed: { type: boolean } } }
  handler: { kind: ref, ref: syncCatalog }
`);
      process.chdir(root);

      expect(await runGenerate(["--no-skills"])).toBe(0);

      const types = await readFile(join(root, ".mantle", "generated", "types.d.ts"), "utf8");
      expect(types.match(/readonly "syncCatalog":/g)).toHaveLength(1);
      expect(types).toContain("ProcInput_import_product");
      expect(types).toContain("ProcOutput_import_product");
      expect(types).toContain("ProcInput_remove_product");
      expect(types).toContain("ProcOutput_remove_product");
      expect(types).toContain("ProcInput_import_product | MantleSite.ProcInput_remove_product");
      expect(types).toContain("ProcOutput_import_product | MantleSite.ProcOutput_remove_product");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
