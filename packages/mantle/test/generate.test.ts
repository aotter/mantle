import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGenerate } from "../src/generate.js";

const originalCwd = process.cwd();

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
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-"));
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

      expect(await runGenerate([])).toBe(0);
      const sitePath = join(root, ".mantle", "generated", "site.ts");
      const typesPath = join(root, ".mantle", "generated", "types.d.ts");
      const firstSite = await readFile(sitePath, "utf8");
      const firstTypes = await readFile(typesPath, "utf8");
      expect(firstSite).toContain("as const satisfies readonly Manifest[]");
      expect(firstTypes.match(/readonly "syncCatalog":/g)).toHaveLength(1);
      expect(firstTypes).toContain("ProcInput_import_product | MantleSite.ProcInput_remove_product");
      expect(firstTypes).toContain("ProcOutput_import_product | MantleSite.ProcOutput_remove_product");

      expect(await runGenerate([])).toBe(0);
      expect(await readFile(sitePath, "utf8")).toBe(firstSite);
      expect(await readFile(typesPath, "utf8")).toBe(firstTypes);
      expect(await runGenerate(["--check"])).toBe(0);

      await writeFile(sitePath, "stale\n");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runGenerate(["--check"])).toBe(1);
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
      const manifestPath = join(root, "manifests", "broken.yaml");
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
      expect(error).toContain("broken.yaml#/0/apiVersion");
      await expect(readFile(join(root, ".mantle", "generated", "site.ts"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
