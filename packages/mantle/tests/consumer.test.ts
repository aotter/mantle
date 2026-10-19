import { afterAll, beforeAll, expect, test } from "bun:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";

const targets = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const;
const files: string[] = [];
const selectedFiles: string[] = [];
const boundaryFiles: string[] = [];
let directory: string | undefined;
beforeAll(async () => {
  const base = fileURLToPath(new URL("apps/.generated/", import.meta.url));
  await mkdir(base, {recursive:true});
  directory = await mkdtemp(join(base, "consumer-"));
  const sources = await loadFixtureSources("purchase.yaml", "store-extra.yaml", "publishing.yaml");
  for (const target of targets) {
    const destination = join(directory, target);
    // unlinked: the consumer resolves @aotter/mantle/* through the package (dist), as an application does
    const generated = await generateOrThrow(target, sources);
    await writeGenerated(destination, generated, false);
    boundaryFiles.push(...Object.keys(generated).filter(name => name.startsWith("paged/") || name.startsWith("validation/") || name.endsWith(".sweepExpired.ts") || name === "mcp.ts").map(name => join(destination, name)));
    files.push(join(destination, "generated.ts"));
    selectedFiles.push(join(destination, "views/purchase-totals.ts"), join(destination, "procedures/create-purchase.ts"));
  }
  // Bun.SQL is the official PostgreSQL handle; postgres.js satisfies the same shape as it is.
  const caller = "{ kind: 'user', subject: 's', role: null, scopes: [], credential: 'session', credentialId: null, clientId: null } as const";
  const drivers = join(directory, "drivers.ts");
  await writeFile(drivers, [
    'import { SQL } from "bun";',
        'import postgres from "postgres";',
    'import { Database } from "bun:sqlite";',
    'import { views as bun, procedures as bunWrites, store as bunStore } from "./bun-postgres/generated.js";',
    'import { store as sqliteStore } from "./bun-sqlite/generated.js";',
    'import { views as d1Views, procedures as d1Procedures, store as d1Store } from "./cloudflare-d1/generated.js";',
    'import { views as worker, store as workerStore } from "./cloudflare-postgres/generated.js";',
    'const sql = new SQL("postgres://localhost/x");',
    `await bun["purchase-totals"](sql, ${caller}, {});`,
    `await sql.begin(async (tx) => bun["purchase-totals"](tx, ${caller}, {}));`,
    `await bunWrites["create-purchase-pair"](sql, ${caller}, { requestNumber: "r", title: "t", amount: 1, approved: true, sortBucket: null, requestedUnits: 1, submittedAt: new Date(), neededOn: "2026-10-11", payload: {} });`,
    `await worker["purchase-totals"](postgres("postgres://localhost/x"), ${caller}, {});`,
    'import pagedList from "./cloudflare-postgres/paged/views/purchase-list.js";',
    'import { postgresIdentity } from "@aotter/mantle/auth/identity";',
    'import { procedures as workerWrites } from "./cloudflare-postgres/generated.js";',
    '// postgres.js types its transaction handle without `begin`: reads take it, Procedures (which may BEGIN) do not.',
    'await postgres("postgres://localhost/x").begin(async tx => {',
    `  await worker["purchase-totals"](tx, ${caller}, {});`,
    `  await pagedList(tx, ${caller}, {});`,
    `  postgresIdentity(tx, {} as Parameters<typeof postgresIdentity>[1], ${caller}, new Headers());`,
    '  // @ts-expect-error a Procedure may open a transaction',
    `  await workerWrites["create-purchase-pair"](tx, ${caller}, { requestNumber: "r", title: "t", amount: 1, approved: true, sortBucket: null, requestedUnits: 1, submittedAt: new Date(), neededOn: "2026-10-11", payload: {} });`,
    '});',
    'import type { WireRow as D1Wire } from "./cloudflare-d1/views/purchase-list.js";',
    'import type { WireRow as PgWire } from "./cloudflare-postgres/views/purchase-list.js";',
    'type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'const sameBoundaryRow: Same<D1Wire,PgWire> = true;',
    'declare const wireRow: D1Wire;',
    'const integerWire: number | string | null = wireRow.requestedunits;',
    'const booleanWire: boolean | null = wireRow.approved;',
    '// @ts-expect-error integer wire can be exact decimal text',
    'const unsafeNumberOnly: number | null = wireRow.requestedunits;',
    // the typed Store: where/orderBy/set are checked against the Schema
    `const generated = bunStore(sql, ${caller});`,
    'const store = generated.collection("purchase_requests");',
    'const tuple = await generated.batch([store.update("id", { title: "t" }, { lock: 1 }), store.delete("id", { lock: 1 })]);',
    'const title: string | null = tuple[0].title;',
    'const deleted: void = tuple[1];',
    '// @ts-expect-error tuple order preserves the delete result',
    'const wrong: string = tuple[1];',
    `const d1 = d1Store({} as import("@cloudflare/workers-types").D1Database, ${caller});`,
    'const session = ({} as import("@cloudflare/workers-types").D1Database).withSession("first-unconstrained") satisfies import("@cloudflare/workers-types").D1DatabaseSession;',
    `await d1Views["purchase-totals"](session, ${caller}, {});`,
    `await d1Procedures["create-purchase-pair"](session, ${caller}, { requestNumber: "r", title: "t", amount: 1, approved: 1, sortBucket: null, requestedUnits: 1, submittedAt: new Date(), neededOn: "2026-10-11", payload: {} });`,
    `await d1Store(session, ${caller}).collection("purchase_requests").count();`,
    'await d1.batch([d1.collection("purchase_requests").delete("id", { lock: 1 })]);',
    '// @ts-expect-error D1 has no interactive transactions',
    'd1.transaction(async () => {});',
    'await generated.transaction(async tx => {',
    '  await tx.collection("purchase_requests").count();',
    '  await tx.views["purchase-totals"]({});',
    '  await tx.procedures["create-purchase-pair"]({ requestNumber: "r", title: "t", amount: 1, approved: true, sortBucket: null, requestedUnits: 1, submittedAt: new Date(), neededOn: "2026-10-11", payload: {} });',
    '  // @ts-expect-error tx has no batch',
    '  tx.batch([]);',
    '  // @ts-expect-error nested transaction is refused',
    '  tx.transaction(async () => {});',
    '}, { isolation: "read committed" });',
    `await sqliteStore(new Database(":memory:"), ${caller}).transaction(async tx => tx.collection("purchase_requests").count());`,
    `await workerStore(postgres("postgres://localhost/x"), ${caller}).transaction(async tx => tx.views["purchase-totals"]({}));`,
    'const page = await store.find({ where: { approved: true, amount: { gte: 1 }, sortbucket: { in: ["a"] }, submittedat: { lt: new Date() } }, orderBy: "title", order: "desc", limit: 5, cursor: "c" });',
    'const row: string | undefined = page.rows[0]?.title ?? undefined;',
    'await store.update("id", { title: "t", payload: { a: 1 }, sortbucket: null }, { lock: 1 });',
    '// @ts-expect-error json columns cannot be ordered by',
    'await store.find({ orderBy: "payload" });',
    '// @ts-expect-error version is no indexed column: ordering by it is a type error',
    'await store.find({ orderBy: "version" });',
    '// @ts-expect-error sortbucket is indexed but nullable: the keyset cursor has no NULL handling, so the type does not offer it',
    'await store.find({ orderBy: "sortbucket" });',
    '// @ts-expect-error the scope column is not a column of the Store: no orderBy, no row key',
    'await store.find({ orderBy: "ownerid" });',
    '// @ts-expect-error the scope and system columns are not writable',
    'await store.update("id", { ownerid: "x", version: 3 }, { lock: 1 });',
    '// @ts-expect-error a required, non-null column cannot be set to null',
    'await store.update("id", { title: null }, { lock: 1 });',
    '// @ts-expect-error a JSON column takes an object or array',
    'await store.update("id", { payload: "text" }, { lock: 1 });',
    'await store.insert({ requestnumber: "r", title: "t", amount: 1, approved: true, sortbucket: null, requestedunits: 1, submittedat: "2026-10-11T00:00:00Z", neededon: "2026-10-11", payload: {} });',
    '// @ts-expect-error a required column is missing',
    'await store.insert({ title: "t" });',
    'await store.delete("id", { lock: 1 });',
    '// @ts-expect-error unknown collection',
    `bunStore(sql, ${caller}).collection("nope");`,
    '// @ts-expect-error amount is a number',
    'await store.update("id", { amount: "x" }, { lock: 1 });',
    '// @ts-expect-error unknown column',
    'await store.count({ nope: 1 });',
    `await sqliteStore(new Database(":memory:"), ${caller}).collection("purchase_requests").findById("x");`,
  ].join("\n"));
  selectedFiles.push(drivers);
}, 30_000);
afterAll(async () => { if (directory) await rm(directory, {recursive:true,force:true}); });

test("four generated consumers typecheck against official native driver types", () => {
  for (const file of files) expect(existsSync(file)).toBe(true);
  const program = ts.createProgram([...files, ...selectedFiles, ...boundaryFiles], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [fileURLToPath(new URL("../node_modules/@types", import.meta.url)), fileURLToPath(new URL("../node_modules", import.meta.url))],
    skipLibCheck: true, types: ["node", "bun-types"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(d => `${d.file?.fileName}:${d.start} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).join("\n")).toBe("");
}, 30_000);

for (const [index, target] of [[2, "cloudflare-d1"]] as const) test(`${target} consumer browser bundle contains no old runtime or compiler`, async () => {
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

for (const [index, target] of [[2, "cloudflare-d1"]] as const) test(`${target} direct View entry excludes unrelated operations`, async () => {
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
  execFileSync(process.execPath, [cli, "cloudflare-d1", destination, manifest], {cwd:directory,stdio:"pipe"});
  await writeFile(join(destination, "views/custom.ts"), 'export default "application-owned";');
  await author(["b"]);
  execFileSync(process.execPath, [cli, "cloudflare-d1", destination, manifest], {cwd:directory,stdio:"pipe"});
  expect(existsSync(join(destination, "views/a.ts"))).toBe(false);
  expect(existsSync(join(destination, "procedures/create-a.ts"))).toBe(false);
  expect(await readFile(join(destination, "views/custom.ts"), "utf8")).toBe('export default "application-owned";');
  const retained = await Bun.build({entrypoints:[join(destination,"views/b.ts"),join(destination,"procedures/create-b.ts")],target:"browser"});
  expect(retained.success).toBe(true);
  const load = (file: string) => execFileSync(process.execPath, ["-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`], {stdio:"pipe"});
  load(join(destination,"views/b.ts"));
  load(join(destination,"procedures/create-b.ts"));
  expect(() => load(join(destination,"views/a.ts"))).toThrow();
  expect(() => load(join(destination,"procedures/create-a.ts"))).toThrow();
}, 30_000);

test("CLI --check reports stale generated files and Wrangler without writing", async () => {
  const destination = join(directory!, "committed dir");
  const manifest = fileURLToPath(new URL("apps/purchase.yaml", import.meta.url));
  const cli = fileURLToPath(new URL("../src/infrastructure/cli.ts", import.meta.url));
  const config = join(directory!, "committed-wrangler.jsonc");
  const args = [cli, "generate", "cloudflare-d1", destination, manifest, "--wrangler", config];
  const run = (check = false) => execFileSync(process.execPath, [...args, ...(check ? ["--check"] : [])], { cwd: directory, stdio: "pipe" });
  expect(() => run(true)).toThrow();
  expect(existsSync(destination)).toBe(false);
  const output = run().toString();
  const attributes = output.split("Add to .gitattributes: ")[1]!.split("\n")[0]!;
  await writeFile(join(directory!, ".gitattributes"), attributes + "\n");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  expect(execFileSync("git", ["check-attr", "linguist-generated", "--", "committed dir/generated.ts"], { cwd: directory, encoding: "utf8" })).toContain("linguist-generated: true");
  expect(() => run(true)).not.toThrow();
  for (const name of ["generated.ts", "schema.sql", "rest.ts"]) expect(await readFile(join(destination, name), "utf8")).toContain("Generated by mantle generate — do not edit.");
  const edited = join(destination, "generated.ts");
  await writeFile(edited, "// hand edit\n");
  await rm(join(destination, "schema.sql"));
  await writeFile(join(destination, "obsolete.ts"), "// Generated by mantle generate — do not edit.\nexport {};\n");
  await writeFile(config, '{"main":"stale.js"}\n');
  try { run(true); throw new Error("check must fail"); } catch (error: any) {
    const output = String(error.stderr);
    for (const name of ["generated.ts", "schema.sql", "obsolete.ts", "committed-wrangler.jsonc"]) expect(output).toContain(name);
  }
  expect(await readFile(edited, "utf8")).toBe("// hand edit\n");
  expect(await readFile(config, "utf8")).toBe('{"main":"stale.js"}\n');
  expect(existsSync(join(destination, "schema.sql"))).toBe(false);
  expect(existsSync(join(destination, "obsolete.ts"))).toBe(true);
  run();
  expect(existsSync(join(destination, "obsolete.ts"))).toBe(false);
  expect(() => run(true)).not.toThrow();
}, 30_000);
