import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGenerate } from "../src/generate.js";

const originalCwd = process.cwd();
const execFileAsync = promisify(execFile);
const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("mantle generate", () => {
  it("rejects an invalid type namespace", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runGenerate(["--namespace", "not-valid"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      '--namespace must be a TypeScript identifier; got "not-valid"\n',
    );
  });

  it("deterministically emits manifests and typed handlers, with a non-mutating check", async () => {
    const root = await mkdtemp(join(originalCwd, ".mantle-generate-"));
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
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  schema:
    type: object
    required: [sku]
    properties:
      sku: { type: string }
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: products-by-sku }
spec:
  from: products
  params:
    type: object
    required: [sku]
    properties:
      sku: { type: string }
  fields: [id, title]
  filter: { eq: { field: sku, value: { $param: sku } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: published-products }
spec:
  from: products
  fields: [id, title]
  filter: { eq: { field: status, value: published } }
`);
      process.chdir(root);

      const generateArgs = ["--namespace", "CmsRuntime"];
      expect(await runGenerate(generateArgs)).toBe(0);
      const sitePath = join(root, ".mantle", "generated", "site.ts");
      const typesPath = join(root, ".mantle", "generated", "types.d.ts");
      await expect(readFile(join(root, ".agent", "skills", "mantle-develop", "SKILL.md"))).rejects.toThrow();
      const firstSite = await readFile(sitePath, "utf8");
      const firstTypes = await readFile(typesPath, "utf8");
      expect(firstSite).toContain("as const satisfies readonly Manifest[]");
      expect(firstSite).toContain("export function bindMantleSite(runtime: CmsRuntime)");
      expect(firstSite).toContain('procedures: {');
      expect(firstTypes.match(/readonly "syncCatalog":/g)).toHaveLength(1);
      expect(firstTypes).toContain("ProcInput_import_product | CmsRuntime.ProcInput_remove_product");
      expect(firstTypes).toContain("ProcOutput_import_product | CmsRuntime.ProcOutput_remove_product");
      expect(firstTypes).toContain("export type ViewParams_products_by_sku");
      expect(firstTypes).toContain("export interface ViewRow_products_by_sku");

      const consumerPath = join(root, "consumer.ts");
      await writeFile(consumerPath, `
import { bindMantleSite } from "./.mantle/generated/site.js";
import type { CmsRuntime } from "@aotter/mantle/runtime";

declare const runtime: CmsRuntime;
const site = bindMantleSite(runtime);
const ctx = { user: null, staff: null, env: {} };
const imported = await site.procedures["import-product"]({ sku: "sku-1" }, ctx);
if (imported.ok) {
  const ok: boolean | undefined = imported.data.imported;
  void ok;
}
// @ts-expect-error Unknown Procedures are absent from the generated surface.
site.procedures["missing"]({}, ctx);
// @ts-expect-error Procedure input is generated from its manifest.
site.procedures["import-product"]({ id: "wrong" }, ctx);
const result = await site.views["products-by-sku"]({ params: { sku: "sku-1" } });
if (result.ok) {
  const title: string | undefined = result.result.rows[0]?.title;
  void title;
}
site.views["published-products"]();
// @ts-expect-error Unknown Views are absent from the generated surface.
site.views["missing"]();
// @ts-expect-error Required View params cannot be omitted.
site.views["products-by-sku"]();
`);
      try {
        await execFileAsync(process.execPath, [
          tscPath,
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--target", "ES2022",
          "--module", "NodeNext",
          "--moduleResolution", "NodeNext",
          "--skipLibCheck",
          consumerPath,
          sitePath,
          typesPath,
        ], { cwd: root });
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string };
        throw new Error(output.stderr || output.stdout || String(error));
      }

      expect(await runGenerate(generateArgs)).toBe(0);
      expect(await readFile(sitePath, "utf8")).toBe(firstSite);
      expect(await readFile(typesPath, "utf8")).toBe(firstTypes);
      expect(await runGenerate([...generateArgs, "--check"])).toBe(0);

      await writeFile(sitePath, "stale\n");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runGenerate([...generateArgs, "--check"])).toBe(1);
      expect(stderr).toHaveBeenCalledWith("Mantle generated files are stale; run `mantle generate`.\n");
      expect(await readFile(sitePath, "utf8")).toBe("stale\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the source file and writes nothing for invalid manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-invalid-"));
    try {
      await mkdir(join(root, "manifests"));
      const manifestPath = join(root, "manifests", "site.yaml");
      await writeFile(manifestPath, `
apiVersion: wrong
kind: Schema
metadata: { name: broken }
spec: {}
`);
      process.chdir(root);
      let error = "";
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        error += String(chunk);
        return true;
      });

      expect(await runGenerate([])).toBe(1);
      expect(error).toContain("INVALID_MANIFEST_ENVELOPE");
      expect(error).toContain("site.yaml#/0/apiVersion");
      await expect(readFile(join(root, ".mantle", "generated", "site.ts"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
