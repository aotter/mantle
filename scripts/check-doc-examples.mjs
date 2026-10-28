#!/usr/bin/env node
// Compile native handbook manifests with the built CLI, then check their TypeScript snippets.
// Generation warnings, type errors and drift under `generate --check` fail the check.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Native handbook examples use the built SDK, without a registry install.
const nativeSdk = join(root, "packages/mantle");
const HANDBOOK = ["start/quickstart-worker.md", "guides/typed-queries.md", "reference/schema.md", "reference/trigger.md", "guides/postgres-adapters.md", "guides/email.md", "guides/sql-patterns.md", "guides/revisions.md"];
const requested = process.argv.slice(2).map(path => resolve(path));
const nativePages = requested.length ? requested : HANDBOOK.map(page => join(root, "docs/handbook", page));
for (const page of nativePages) {
  const source = readFileSync(page, "utf8");
  const blocks = [...source.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(match => match[1]);
  if (!blocks.some(block => block.includes("apiVersion: cms.mantle.aotter.net/v2")) && !["postgres-adapters.md", "email.md"].some(name => page.endsWith("/" + name))) throw new Error(`${page}: no v2 manifest block`);
  const project = mkdtempSync(join(tmpdir(), "mantle-native-docs-"));
  try {
    mkdirSync(join(project, "node_modules/@aotter"), {recursive:true});
    mkdirSync(join(project, "node_modules/@cloudflare"), {recursive:true});
    symlinkSync(nativeSdk, join(project, "node_modules/@aotter/mantle"), "dir");
    symlinkSync(join(nativeSdk,"node_modules/better-auth"), join(project,"node_modules/better-auth"), "dir");
    symlinkSync(join(nativeSdk,"node_modules/@cloudflare/workers-types"), join(project,"node_modules/@cloudflare/workers-types"), "dir");
    writeFileSync(join(project,"package.json"), '{"type":"module"}\n');
    blocks.forEach((block,index) => writeFileSync(join(project, `${index}.yaml`),block));
    const cli = join(nativeSdk,"dist/infrastructure/cli.js");
    const generate = [cli,"generate","cloudflare-d1","generated",...blocks.map((_,index)=>`${index}.yaml`)];
    for (const args of blocks.length ? [generate,[...generate,"--check"]] : []) {
      const run = spawnSync(process.execPath,args,{cwd:project,encoding:"utf8"});
      if (run.status !== 0 || /^warning:/m.test(run.stdout + run.stderr)) throw new Error(`${page}: ${run.stdout}${run.stderr}`);
    }
    const code = [...source.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map(match=>match[1]);
    for (const [index,block] of code.entries()) {
      const directory = block.includes("../generated/") ? join(project,"src") : project;
      mkdirSync(directory,{recursive:true});
      writeFileSync(join(directory,`example${index}.ts`), block);
    }
    writeFileSync(join(project,"tsconfig.json"), JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",strict:true,noEmit:true,skipLibCheck:true,types:["@cloudflare/workers-types"]},include:["**/*.ts"]}));
    const types = spawnSync(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p",project],{cwd:project,encoding:"utf8"});
    if (types.status !== 0) throw new Error(`${page}: ${types.stdout}${types.stderr}`);
  } finally { rmSync(project,{recursive:true,force:true}); }
}
console.log(`check-doc-examples: ${nativePages.length} native handbook pages typecheck; manifest examples also generate and --check`);
