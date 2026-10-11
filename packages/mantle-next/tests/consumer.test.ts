import { afterAll, beforeAll, expect, test } from "bun:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";

const targets = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const;
const files: string[] = [];
const selectedFiles: string[] = [];
let directory: string | undefined;
beforeAll(async () => {
  const base = fileURLToPath(new URL("apps/.generated/", import.meta.url));
  await mkdir(base, {recursive:true});
  directory = await mkdtemp(join(base, "consumer-"));
  const text = await readFile(new URL("apps/purchase.yaml", import.meta.url), "utf8");
  for (const target of targets) {
    const generated = await generateFromSources({target, sources:{sources:[{sourceId:"purchase.yaml",text}]}});
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const destination = join(directory, target);
    await mkdir(destination);
    const file = join(destination, "generated.ts");
    for (const [name, text] of Object.entries(generated.files)) {
      await mkdir(dirname(join(destination, name)), { recursive: true });
      await writeFile(join(destination, name), text);
    }
    files.push(file);
    selectedFiles.push(join(destination, "views/purchase-totals.ts"), join(destination, "procedures/create-purchase.ts"));
  }
  // Bun.SQL is the official PostgreSQL handle; node-postgres reaches it through the documented adapter.
  const caller = "{ kind: 'user', subject: 's', role: null, scopes: [], credential: 'session', credentialId: null, clientId: null } as const";
  const drivers = join(directory, "drivers.ts");
  await writeFile(drivers, [
    'import { SQL } from "bun";', 'import { Client } from "pg";',
    `import { pgPort } from ${JSON.stringify(fileURLToPath(new URL("apps/pg-port.js", import.meta.url)))};`,
    'import { views as bun, procedures as bunWrites } from "./bun-postgres/generated.js";',
    'import { views as worker } from "./cloudflare-postgres/generated.js";',
    'const sql = new SQL("postgres://localhost/x");',
    `await bun["purchase-totals"](sql, ${caller}, {});`,
    `await sql.begin(async (tx) => bun["purchase-totals"](tx, ${caller}, {}));`,
    `await bunWrites["create-purchase-pair"](sql, ${caller}, { requestNumber: "r", title: "t", amount: 1, approved: true, sortBucket: null, requestedUnits: 1, submittedAt: new Date(), neededOn: "2026-10-11", payload: "{}" });`,
    `await worker["purchase-totals"](pgPort(new Client()), ${caller}, {});`,
  ].join("\n"));
  selectedFiles.push(drivers);
});
afterAll(async () => { if (directory) await rm(directory, {recursive:true,force:true}); });

test("four generated consumers typecheck against official native driver types", () => {
  for (const file of files) expect(existsSync(file)).toBe(true);
  const program = ts.createProgram([...files, ...selectedFiles], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [fileURLToPath(new URL("../node_modules/@types", import.meta.url)), fileURLToPath(new URL("../node_modules", import.meta.url))],
    skipLibCheck: true, types: ["node", "bun-types"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(d => `${d.file?.fileName}:${d.start} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).join("\n")).toBe("");
}, 15_000);

for (const [index, target] of targets.entries()) test(`${target} consumer browser bundle contains no old runtime or compiler`, async () => {
  const bundle = await Bun.build({ entrypoints: [files[index]!], target: "browser", sourcemap: "external" });
  expect(bundle.success).toBe(true);
  const map = bundle.outputs.find(output => output.path.endsWith(".map"));
  expect(map).toBeDefined();
  const sources = (await map!.json()).sources as string[];
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.some(source => /(?:^|\/)mantle\/(?:src|dist)\//.test(source) || /@aotter\/mantle(?:\/|$)/.test(source))).toBe(false);
  const code = await bundle.outputs.find(output => !output.path.endsWith(".map"))!.text();
  expect(code).not.toMatch(/RuntimePlan|compilePlan|runView|runProcedure|compileCached|StoreExecutor/);
});

for (const [index, target] of targets.entries()) test(`${target} direct View entry excludes unrelated operations`, async () => {
  const bundle = await Bun.build({ entrypoints: [selectedFiles[index * 2]!], target: "browser", minify: true });
  expect(bundle.success).toBe(true);
  const code = await bundle.outputs[0]!.text();
  expect(code).toContain("requestCount");
  expect(code).not.toContain("purchase-calendar");
  expect(code).not.toContain("create-purchase");
  expect(code).not.toContain("submittedDay");
});

test("CLI regeneration cannot route removed operation entries to renumbered functions", async () => {
  const atoms = (await readFile(new URL("apps/purchase.yaml", import.meta.url), "utf8")).split(/^---\s*$/m).map(part => JSON.parse(part));
  const schemas = atoms.filter(atom => atom.kind === "Schema");
  const examples = [atoms.find(atom => atom.metadata.name === "purchase-totals"), atoms.find(atom => atom.metadata.name === "create-purchase")];
  const destination = join(directory!, "regeneration");
  const manifest = join(directory!, "regeneration.yaml");
  const author = async (names: string[]) => writeFile(manifest, [...schemas, ...examples.flatMap(atom => names.map(name => ({...atom, metadata:{name:atom.kind === "Procedure" ? "create-" + name : name}})))].map(atom => JSON.stringify(atom)).join("\n---\n"));
  const cli = fileURLToPath(new URL("../src/infrastructure/cli.ts", import.meta.url));
  await author(["a", "b"]);
  execFileSync(process.execPath, [cli, "cloudflare-d1", destination, manifest], {stdio:"pipe"});
  await author(["b"]);
  execFileSync(process.execPath, [cli, "cloudflare-d1", destination, manifest], {stdio:"pipe"});
  const retained = await Bun.build({entrypoints:[join(destination,"views/b.ts"),join(destination,"procedures/create-b.ts")],target:"browser"});
  expect(retained.success).toBe(true);
  const load = (file: string) => execFileSync(process.execPath, ["-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`], {stdio:"pipe"});
  load(join(destination,"views/b.ts"));
  load(join(destination,"procedures/create-b.ts"));
  expect(() => load(join(destination,"views/a.ts"))).toThrow();
  expect(() => load(join(destination,"procedures/create-a.ts"))).toThrow();
}, 15_000);
