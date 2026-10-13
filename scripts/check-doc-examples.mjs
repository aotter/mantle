#!/usr/bin/env node
// Every example page under docs/examples/ (and the HANDBOOK pages below) is a whole service: its ```yaml blocks are the manifests. Each page is compiled by the
// built `mantle` CLI in a scratch project (`generate`, then `generate --check`), so a page that stops compiling, or compiles with a warning, fails `pnpm check`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "docs/examples");
// These pages explicitly document alpha.6 RuntimePlan. Test their exact historical
// package; the native reference service is checked separately from current tarballs.
// Current handbook examples use the built native SDK, without a registry install.
const nativeSdk = join(root, "packages/mantle");
const HANDBOOK = ["start/quickstart-worker.md", "guides/typed-queries.md", "reference/schema.md", "reference/trigger.md", "guides/postgres-adapters.md", "guides/email.md"];
const requested = process.argv.slice(2).map(path => resolve(path));
const nativePages = requested.length ? requested.filter(path => path.startsWith(join(root, "docs/handbook") + "/")) : HANDBOOK.map(page => join(root, "docs/handbook", page));
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
const historicalPages = requested.length ? requested.filter(path => !nativePages.includes(path)) : readdirSync(examples).filter(name=>name.endsWith(".md") && name!=="README.md").map(name=>join(examples,name));
if (!historicalPages.length) process.exit(0);
const legacy = mkdtempSync(join(tmpdir(), "mantle-legacy-docs-"));
const legacyVersion = "0.2.0-alpha.6";
writeFileSync(join(legacy, "package.json"), JSON.stringify({private:true,type:"module",dependencies:{"@aotter/mantle":legacyVersion}}));
execFileSync("pnpm",["install","--ignore-scripts","--no-frozen-lockfile"],{cwd:legacy,stdio:"pipe"});
const legacySdk = join(legacy,"node_modules/@aotter/mantle");
const cli = join(legacySdk,"dist/cli/main.js");
const pages = historicalPages;

const failures = [];
try {
for (const page of pages) {
  const blocks = [...readFileSync(page, "utf8").matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
  if (!blocks.some((block) => block.includes("apiVersion: cms.mantle.aotter.net/v2"))) {
    failures.push(`${page}: no v2 manifest block`);
    continue;
  }
  const project = mkdtempSync(join(tmpdir(), "mantle-doc-example-"));
  try {
    mkdirSync(join(project, "manifests"));
    mkdirSync(join(project, "node_modules/@aotter"), { recursive: true });
    symlinkSync(legacySdk, join(project, "node_modules/@aotter/mantle"), "dir");
    writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
    blocks.forEach((block, index) => writeFileSync(join(project, "manifests", `${index}.yaml`), block));
    // identity none and REST only, on SQLite named as `mantle generate --dialect sqlite` writes it: the page's manifests are what is checked, not the peers a fuller selection needs
    // a warning fails too: an example teaches what a clean manifest looks like.
    for (const args of [[cli, "generate", "--identity", "none", "--features", "web", "--dialect", "sqlite"], [cli, "generate", "--check"]]) {
      const run = spawnSync(process.execPath, args, { cwd: project, encoding: "utf8" });
      if (run.status !== 0 || /^warning:/m.test(run.stdout + run.stderr)) {
        failures.push(`${page}: ${args.slice(1).join(" ")}\n${run.stdout}${run.stderr}`);
        break;
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

} finally { rmSync(legacy,{recursive:true,force:true}); }

if (failures.length) {
  console.error(`check-doc-examples: ${failures.length} page(s) failed\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`check-doc-examples: ${pages.length} historical page(s) compile with alpha.6; current native service uses check-worker-consumer`);
