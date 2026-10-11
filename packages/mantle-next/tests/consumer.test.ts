import { afterAll, beforeAll, expect, test } from "bun:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";

const targets = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const;
const files: string[] = [];
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
    await writeFile(file, generated.files["generated.ts"]!);
    files.push(file);
  }
});
afterAll(async () => { if (directory) await rm(directory, {recursive:true,force:true}); });

test("four generated consumers typecheck against official native driver types", () => {
  for (const file of files) expect(existsSync(file)).toBe(true);
  const program = ts.createProgram(files, {
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
