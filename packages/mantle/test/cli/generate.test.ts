import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdminUiIndexHtml, runGenerate } from "../../src/cli/generate.js";

const coreOnly = { resolveAdminUiIndexHtml: () => null };

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
      '--namespace must be a non-reserved TypeScript identifier; got "not-valid"\n',
    );
    expect(await runGenerate(["--namespace", "MantleHandlers"])).toBe(2);
  });

  it("emits and runs one deterministic typed Mantle module", async () => {
    const root = await mkdtemp(join(originalCwd, ".mantle-generate-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      process.chdir(root);

      expect(await runGenerate([], coreOnly)).toBe(0);
      const mantlePath = join(root, ".mantle", "generated", "mantle.ts");
      const firstMantle = await readFile(mantlePath, "utf8");
      expect(firstMantle).toContain("export async function createMantle<Env = unknown>");
      expect(firstMantle).toContain("export function bindMantle(runtime: CoreMantleRuntime)");
      expect(firstMantle).toContain("export const plan = sealRuntimePlan(");
      expect(firstMantle).toContain("productsBySku: (request:");
      expect(firstMantle).toContain('view: "products-by-sku"');
      expect(firstMantle).toContain("importProduct: (input:");
      expect(firstMantle).toContain('procedure: "import-product"');
      expect(firstMantle).toContain("products: {");
      expect(firstMantle).toContain('collection: "products"');
      expect(firstMantle.match(/readonly "syncCatalog":/g)).toHaveLength(1);
      expect(firstMantle).toContain("ProcInput_import_product | Mantle.ProcInput_remove_product");
      await expect(readFile(join(root, "public", "_mantle", "admin", "index.html")))
        .rejects.toThrow();

      const consumerPath = join(root, "consumer.ts");
      await writeFile(consumerPath, `
import { bindMantle, createMantle, plan } from "./.mantle/generated/mantle.js";
import type { MantleRuntime, MantleStorageAdapter } from "@aotter/mantle/runtime";

const calls: string[] = [];
const runtime = {
  revision: plan.semanticFingerprint,
  createDraft: { execute: async (request: { collection: string; data: unknown }) => {
    calls.push("entry:" + request.collection);
    return request;
  } },
  executeView: async (request: { view: string }) => {
    calls.push("view:" + request.view);
    return { ok: true as const, result: { rows: [{ id: "1", title: "Typed" }], page: 1, show: 20, hasMore: false } };
  },
  invokeProcedure: async (request: { procedure: string }) => {
    calls.push("procedure:" + request.procedure);
    return { ok: true as const, data: { imported: true } };
  },
} as unknown as MantleRuntime;

const mantle = bindMantle(runtime);
if (mantle.runtime !== runtime) throw new Error("raw runtime escape hatch changed");
await mantle.entries.products.createDraft({ data: { sku: "sku-1" }, authorId: null });
const view = await mantle.views.productsBySku({ params: { sku: "sku-1" } });
const procedure = await mantle.procedures.importProduct(
  { sku: "sku-1" },
  { user: null, staff: null, env: {} },
);
if (!view.ok || view.result.rows[0]?.title !== "Typed") throw new Error("typed View failed");
if (!procedure.ok || procedure.data.imported !== true) throw new Error("typed Procedure failed");
if (calls.join(",") !== "entry:products,view:products-by-sku,procedure:import-product") {
  throw new Error("wire names changed: " + calls.join(","));
}

const storage = {
  async prepare() {
    return {
      entries: {},
      views: {
        async execute() {
          return { rows: [{ id: "2", title: "Created" }], page: 1, show: 20, hasMore: false };
        },
      },
    };
  },
} as unknown as MantleStorageAdapter;
const created = await createMantle({
  storage,
  handlers: { syncCatalog: () => ({ imported: true }) },
});
const createdView = await created.views.productsBySku({ params: { sku: "sku-2" } });
if (!createdView.ok || createdView.result.rows[0]?.title !== "Created") {
  throw new Error("one-step Mantle creation failed");
}
if (created.runtime.revision !== plan.semanticFingerprint) throw new Error("created runtime revision changed");

let rejectedMismatch = false;
try {
  bindMantle({ ...runtime, revision: "wrong-revision" });
} catch {
  rejectedMismatch = true;
}
if (!rejectedMismatch) throw new Error("generated binding accepted another revision");

if (false) {
  // @ts-expect-error Unknown Views are absent from the generated surface.
  mantle.views.missing();
  // @ts-expect-error Required View params cannot be omitted.
  mantle.views.productsBySku();
  // @ts-expect-error Schema payload is generated from the manifest.
  await mantle.entries.products.createDraft({ data: { title: "missing sku" }, authorId: null });
}
`);
      const compiled = join(root, "compiled");
      try {
        await execFileAsync(process.execPath, [
          tscPath,
          "--ignoreConfig",
          "--strict",
          "--target", "ES2022",
          "--module", "NodeNext",
          "--moduleResolution", "NodeNext",
          "--skipLibCheck",
          "--rootDir", root,
          "--outDir", compiled,
          consumerPath,
          mantlePath,
        ], { cwd: root });
        await execFileAsync(process.execPath, [join(compiled, "consumer.js")], { cwd: root });
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string };
        throw new Error(output.stderr || output.stdout || String(error));
      }

      expect(await runGenerate([], coreOnly)).toBe(0);
      expect(await readFile(mantlePath, "utf8")).toBe(firstMantle);
      expect(await runGenerate(["--check"], coreOnly)).toBe(0);

      const adminIndexPath = join(root, "public", "_mantle", "admin", "index.html");
      await mkdir(join(root, "public", "_mantle", "admin"), { recursive: true });
      await writeFile(adminIndexPath, "owned by the host\n");
      expect(await runGenerate(["--check"], coreOnly)).toBe(0);
      expect(await readFile(adminIndexPath, "utf8")).toBe("owned by the host\n");

      await writeFile(mantlePath, "stale\n");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runGenerate(["--check"], coreOnly)).toBe(1);
      expect(stderr).toHaveBeenCalledWith("Mantle generated files are stale; run `mantle generate`.\n");
      expect(await readFile(mantlePath, "utf8")).toBe("stale\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails normalized identifier collisions at the authored source", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-collision-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), `
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec: { title: Products, schema: { type: object } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open-orders }
spec: { surface: public, from: products }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open.orders }
spec: { surface: public, from: products }
`);
      process.chdir(root);
      let error = "";
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        error += String(chunk);
        return true;
      });

      expect(await runGenerate([])).toBe(1);
      expect(error).toContain("CODEGEN_IDENTIFIER_COLLISION");
      expect(error).toContain("site.yaml#/2/metadata/name");
      expect(error).toContain("'open-orders' and 'open.orders' both generate 'openOrders'");
      await expect(readFile(join(root, ".mantle", "generated", "mantle.ts"))).rejects.toThrow();
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
      await expect(readFile(join(root, ".mantle", "generated", "mantle.ts"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips Admin assets when the optional UI package does not resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-core-only-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      process.chdir(root);

      expect(await runGenerate([], coreOnly)).toBe(0);
      expect(await readFile(join(root, ".mantle", "generated", "mantle.ts"), "utf8"))
        .toContain("export async function createMantle<Env = unknown>");
      await expect(readFile(join(root, "public", "_mantle", "admin", "index.html")))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("syncs Admin SPA assets when the optional UI package resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-admin-"));
    const adminDist = await mkdtemp(join(tmpdir(), "mantle-admin-ui-dist-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      await mkdir(join(adminDist, "assets"));
      await writeFile(join(adminDist, "index.html"), "<!doctype html><title>Admin</title>\n");
      await writeFile(join(adminDist, "assets", "app.js"), "console.log('admin');\n");
      await writeFile(join(adminDist, "server.js"), "export const systemTokensCss = '';\n");
      await writeFile(join(adminDist, "server.d.ts"), "export declare const systemTokensCss: string;\n");
      process.chdir(root);

      const deps = { resolveAdminUiIndexHtml: () => join(adminDist, "index.html") };
      expect(await runGenerate([], deps)).toBe(0);

      const adminIndexPath = join(root, "public", "_mantle", "admin", "index.html");
      expect(await readFile(adminIndexPath, "utf8")).toBe("<!doctype html><title>Admin</title>\n");
      expect(await readFile(join(root, "public", "_mantle", "admin", "assets", "app.js"), "utf8"))
        .toBe("console.log('admin');\n");
      await expect(readFile(join(root, "public", "_mantle", "admin", "server.js"))).rejects.toThrow();
      await expect(readFile(join(root, "public", "_mantle", "admin", "server.d.ts"))).rejects.toThrow();
      expect(await runGenerate(["--check"], deps)).toBe(0);

      await writeFile(adminIndexPath, "corrupted\n");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runGenerate(["--check"], deps)).toBe(1);
      expect(stderr).toHaveBeenCalledWith("Mantle generated files are stale; run `mantle generate`.\n");
      expect(await readFile(adminIndexPath, "utf8")).toBe("corrupted\n");
      stderr.mockRestore();

      expect(await runGenerate([], deps)).toBe(0);
      expect(await readFile(adminIndexPath, "utf8")).toBe("<!doctype html><title>Admin</title>\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(adminDist, { recursive: true, force: true });
    }
  });

  it("resolves the workspace Admin UI package when it is installed", () => {
    const resolved = resolveAdminUiIndexHtml();
    expect(resolved).toMatch(/index\.html$/);
  });
});

const fixture = `
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: import-product }
spec:
  input: { type: object, required: [sku], properties: { sku: { type: string } } }
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
  surface: public
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
  surface: public
  from: products
  fields: [id, title]
  filter: { eq: { field: status, value: published } }
`;
