import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printGenerateNextSteps, resolveAdminUiIndexHtml, runGenerate, warnMissingWranglerAssets } from "../../src/cli/generate.js";

const coreOnly = { resolveAdminUiIndexHtml: () => null };

const originalCwd = process.cwd();
const execFileAsync = promisify(execFile);
const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("mantle generate", () => {
  it("rejects starter types and requires a host for a new full project", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-no-scaffold-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.chdir(root);
      expect(await runGenerate(["blank"], coreOnly)).toBe(2);
      expect(await runGenerate([], coreOnly)).toBe(2);
      expect(stderr.mock.calls.flat().join("")).toContain("Host required");
      expect(await readdir(root)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid type namespace", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runGenerate(["--namespace", "not-valid"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      '--namespace must be a non-reserved TypeScript identifier; got "not-valid"\n',
    );
    expect(await runGenerate(["--namespace", "MantleHandlers"])).toBe(2);
    expect(await runGenerate(["--namespace", "StoreRow"])).toBe(2);
    expect(await runGenerate(["--namespace", "HandlerContext"])).toBe(2);
    expect(await runGenerate(["--namespace", "ViewOptions"])).toBe(2);
    expect(await runGenerate(["--namespace", "Omit"])).toBe(2);
  });

  it("typechecks the handbook internal View example against generated bindings", async () => {
    const guide = await readFile(join(originalCwd, "../../docs/handbook/guides/typed-queries.md"), "utf8");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(guide)?.[1];
    const source = /```ts\n([\s\S]*?)```/.exec(guide)?.[1];
    expect(yaml).toBeTruthy();
    expect(source).toBeTruthy();
    const root = await mkdtemp(join(originalCwd, ".mantle-handbook-"));
    try {
      await mkdir(join(root, "manifests"));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "manifests/tickets.yaml"), yaml!);
      await writeFile(join(root, "src/queries.ts"), source!);
      process.chdir(root);
      expect(await runGenerate([], coreOnly)).toBe(0);
      try {
        await execFileAsync(process.execPath, [tscPath, "--ignoreConfig", "--noEmit",
          "--strict", "--target", "ES2022", "--module", "NodeNext",
          "--moduleResolution", "NodeNext", "--skipLibCheck", "src/queries.ts"], { cwd: root });
      } catch (error) {
        throw new Error((error as { stdout?: string }).stdout || String(error));
      }
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits deterministic wire-keyed Store types without per-name runtime wrappers", async () => {
    const root = await mkdtemp(join(originalCwd, ".mantle-generate-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      process.chdir(root);
      expect(await runGenerate([], coreOnly)).toBe(0);
      const mantlePath = join(root, ".mantle", "generated", "mantle.ts");
      const firstMantle = await readFile(mantlePath, "utf8");
      expect(firstMantle).toContain("export const plan = sealRuntimePlan(");
      expect(firstMantle).toContain('readonly "products": Mantle.Entry_products;');
      expect(firstMantle).toContain('readonly "products-by-sku":');
      expect(firstMantle).toContain('readonly "syncCatalog": RuntimeHandlerFn<');
      expect(firstMantle).not.toContain("function bindMantle");
      expect(firstMantle).not.toContain("function createMantle");
      await expect(readFile(join(root, "public", "_mantle", "admin", "index.html"))).rejects.toThrow();

      const consumerPath = join(root, "consumer.ts");
      await writeFile(consumerPath, `
import { plan } from "./.mantle/generated/mantle.js";
import type { Store, MantleHandlers } from "./.mantle/generated/mantle.js";
import type { MantleRuntime } from "@aotter/mantle/runtime";

const calls: string[] = [];
const runtime = {
  revision: plan.semanticFingerprint,
  store: {
    select: async (query: { from: string }) => {
      calls.push("select:" + query.from);
      return { rows: [{ id: "1", sku: "sku-1", title: "Typed" }] };
    },
    write: async (ops: readonly { insert?: string }[]) => {
      calls.push("write:" + ops[0]?.insert);
      return [{ id: "2", version: 1 }];
    },
    view: async (name: string) => {
      calls.push("view:" + name);
      return { rows: [{ id: "1", title: "Typed" }], page: 1, show: 20, hasMore: false };
    },
  },
} as unknown as MantleRuntime;
const store = runtime.store as Store;
if (false) {
  const callerStore = store.as({ user: { id: "u1" }, staff: null, env: {} });
  const callerRow: string | undefined = (await callerStore.select({ from: "products" })).rows[0]?.sku;
  void callerRow;
}
const selected = await store.select({ from: "products", where: { sku: "sku-1" } });
const sku: string | undefined = selected.rows[0]?.sku;
if (sku !== "sku-1") throw new Error("typed select failed");
const view = await store.view("products-by-sku", { params: { sku: "sku-1" } });
if (view.rows[0]?.title !== "Typed") throw new Error("typed View failed");
await store.write([{ insert: "products", values: { sku: "sku-2" } }]);
if (calls.join(",") !== "select:products,view:products-by-sku,write:products") throw new Error(calls.join(","));
const handler: MantleHandlers["syncCatalog"] = (_input, ctx) => {
  void store.as(ctx);
  if (ctx.store) {
    // @ts-expect-error Caller Store cannot rebind its identity.
    void ctx.store.as(ctx);
    void ctx.store.select({ from: "products", limit: 1 });
    void ctx.store.write([{ insert: "scoped-posts", values: { title: "Owned" } }]);
    // @ts-expect-error A non-filled required field remains required.
    void ctx.store.write([{ insert: "scoped-posts", values: {} }]);
    // @ts-expect-error Open Schema index signatures cannot erase declared field types.
    void ctx.store.write([{ insert: "scoped-posts", values: { title: 42 } }]);
    // @ts-expect-error Handler Store uses the same wire-keyed Schema map.
    void ctx.store.select({ from: "missing" });
  }
  return { imported: true };
};
void handler;
if (false) {
  // @ts-expect-error Unknown Schema wire names are rejected.
  await store.select({ from: "missing" });
  // @ts-expect-error Required View params cannot be omitted.
  await store.view("products-by-sku");
  // @ts-expect-error Unknown View wire names are rejected.
  await store.view("missing");
  // @ts-expect-error Insert values retain declared field types even when fields are optional.
  await store.write([{ insert: "products", values: { sku: 42 } }]);
  // @ts-expect-error Unscoped host writes must supply the owner field.
  await store.write([{ insert: "scoped-posts", values: { title: "Owned" } }]);
  await store.write([{ insert: "scoped-posts", values: { ownerId: "u-1", title: "Owned" } }]);
}
`);
      const compiled = join(root, "compiled");
      try {
        await execFileAsync(process.execPath, [
          tscPath, "--ignoreConfig", "--strict", "--target", "ES2022",
          "--module", "NodeNext", "--moduleResolution", "NodeNext",
          "--skipLibCheck", "--rootDir", root, "--outDir", compiled,
          consumerPath, mantlePath,
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

  it("keeps colliding lower-camel View names as distinct wire keys", async () => {
    const root = await mkdtemp(join(originalCwd, ".mantle-collision-"));
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
      expect(await runGenerate([], coreOnly)).toBe(0);
      const generated = await readFile(join(root, ".mantle", "generated", "mantle.ts"), "utf8");
      expect(generated).toContain('readonly "open-orders": {');
      expect(generated).toContain('readonly "open.orders": {');
      expect(generated).toContain('ViewRow_open_u002d_orders');
      expect(generated).toContain('ViewRow_open_u002e_orders');
      try {
        await execFileAsync(process.execPath, [tscPath, "--ignoreConfig", "--noEmit",
          "--strict", "--target", "ES2022", "--module", "NodeNext",
          "--moduleResolution", "NodeNext", "--skipLibCheck",
          join(root, ".mantle", "generated", "mantle.ts")], { cwd: root });
      } catch (error) {
        throw new Error((error as { stdout?: string }).stdout || String(error));
      }
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
        .toContain("export interface Schemas");
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

  it("prints the API-only next step when Admin UI is not installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-api-only-tip-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      process.chdir(root);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await runGenerate([], coreOnly)).toBe(0);
      expect(stdout.mock.calls.flat().join("")).toMatch(/API-only \(Admin is opt-in\)/);
      expect(stdout.mock.calls.flat().join("")).toMatch(/local-admin-otp/);
      stdout.mockClear();
      expect(await runGenerate(["--check"], coreOnly)).toBe(0);
      expect(stdout.mock.calls.flat().join("")).not.toMatch(/API-only/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints Admin next steps when Admin UI is synced", async () => {
    const notes: string[] = [];
    printGenerateNextSteps(true, (chunk) => {
      notes.push(String(chunk));
      return true;
    });
    expect(notes.join("")).toMatch(/opt-in/);
    expect(notes.join("")).toMatch(/\/admin\/sign-in/);
    expect(notes.join("")).toMatch(/ConsoleEmailSender/);
    expect(notes.join("")).toMatch(/ASSETS/);
    expect(notes.join("")).toMatch(/PUBLIC_ORIGIN must equal the origin wrangler prints/);
    expect(notes.join("")).toMatch(/INVALID_ORIGIN/);
    expect(notes.join("")).toMatch(/docs\/examples\/host-local-admin-otp/);
    expect(notes.join("")).toMatch(/node_modules\/@aotter\/mantle\/docs\/examples\/host-local-admin-otp/);
    notes.length = 0;
    printGenerateNextSteps(false, (chunk) => {
      notes.push(String(chunk));
      return true;
    });
    expect(notes.join("")).toMatch(/API-only/);
    expect(notes.join("")).toMatch(/docs\/examples\/host-local-admin-otp/);
    expect(notes.join("")).toMatch(/node_modules\/@aotter\/mantle\/docs\/examples\/host-local-admin-otp/);
    expect(notes.join("")).not.toMatch(/sign-in/);
  });

  it("pins the official Admin OTP example to the same host as PUBLIC_ORIGIN", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../../../docs/examples/host-local-admin-otp/package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.dev).toMatch(/--ip 127\.0\.0\.1/);
    expect(pkg.scripts.dev).toMatch(/--port 8787/);
  });

  it("pins the official minimal Worker example to the same local host", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../../../docs/examples/host-minimal-worker/package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.dev).toMatch(/--ip 127\.0\.0\.1/);
    expect(pkg.scripts.dev).toMatch(/--port 8787/);
  });

  it("warns when Admin UI is synced but wrangler has no ASSETS binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-generate-assets-warn-"));
    const adminDist = await mkdtemp(join(tmpdir(), "mantle-admin-ui-dist-"));
    try {
      await mkdir(join(root, "manifests"));
      await writeFile(join(root, "manifests", "site.yaml"), fixture);
      await writeFile(join(adminDist, "index.html"), "<!doctype html><title>Admin</title>\n");
      await writeFile(join(root, "wrangler.jsonc"), "{ \"name\": \"demo\", \"main\": \"src/index.ts\" }\n");
      process.chdir(root);
      const deps = { resolveAdminUiIndexHtml: () => join(adminDist, "index.html") };
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runGenerate([], deps)).toBe(0);
      expect(stderr.mock.calls.flat().join("")).toMatch(/no ASSETS binding/);
      stderr.mockClear();
      expect(await runGenerate(["--check"], deps)).toBe(0);
      expect(stderr.mock.calls.flat().join("")).not.toMatch(/ASSETS/);
      await writeFile(
        join(root, "wrangler.jsonc"),
        "{ \"assets\": { \"directory\": \"./public\", \"binding\": \"ASSETS\" } }\n",
      );
      stderr.mockClear();
      expect(await runGenerate([], deps)).toBe(0);
      expect(stderr.mock.calls.flat().join("")).not.toMatch(/ASSETS/);
      const notes: string[] = [];
      warnMissingWranglerAssets(root, (chunk) => {
        notes.push(String(chunk));
        return true;
      });
      expect(notes.join("")).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(adminDist, { recursive: true, force: true });
    }
  });

  it.skipIf(resolveAdminUiIndexHtml() === null)(
    "copies the installed Admin UI SPA when generate uses the default resolver",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mantle-generate-installed-admin-"));
      try {
        await mkdir(join(root, "manifests"));
        await writeFile(join(root, "manifests", "site.yaml"), fixture);
        process.chdir(root);

        expect(await runGenerate([])).toBe(0);
        const adminIndexPath = join(root, "public", "_mantle", "admin", "index.html");
        expect(await readFile(adminIndexPath, "utf8")).toContain("/_mantle/admin/");
        await expect(readFile(join(root, "public", "_mantle", "admin", "server.js")))
          .rejects.toThrow();
        expect(await runGenerate(["--check"])).toBe(0);

        await writeFile(adminIndexPath, "corrupted\n");
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        expect(await runGenerate(["--check"])).toBe(1);
        expect(stderr).toHaveBeenCalledWith(
          "Mantle generated files are stale; run `mantle generate`.\n",
        );
        expect(await readFile(adminIndexPath, "utf8")).toBe("corrupted\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
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
kind: Schema
metadata: { name: members }
spec:
  title: Members
  schema:
    type: object
    additionalProperties: false
    required: [code]
    properties:
      code: { type: string }
      seats: { type: number }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: scoped-posts }
spec:
  title: Scoped posts
  scope: { ownerId: "$ctx.user.id" }
  schema:
    type: object
    required: [ownerId, title, state]
    properties:
      ownerId: { type: string }
      title: { type: string }
      state: { type: string, default: draft }
  indexes: [[ownerId]]
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
