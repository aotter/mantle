/** Inspect the actual tarball, not package.json's intended inclusion list. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const directory = await mkdtemp(resolve(tmpdir(), "mantle-next-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd:resolve(import.meta.dir,".."), stdio:"pipe" });
  const archive = resolve(directory, (await readdir(directory)).find(name => name.endsWith(".tgz"))!);
  const names = execFileSync("tar", ["-tzf", archive], {encoding:"utf8"}).trim().split("\n");
  const allowed = /^package\/(?:package\.json|README\.md|LICENSE|(?:docs|skills)\/[A-Za-z0-9_./@-]+|dist\/[A-Za-z0-9_/-]+\.(?:js|d\.ts))$/;
  assert.ok(names.every(name => allowed.test(name)), `unexpected package files: ${names.filter(name => !allowed.test(name))}`);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  for (const name of names.filter(name => name.endsWith(".d.ts"))) {
    const text = (await readFile(resolve(directory, name), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, path] of text.matchAll(/["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(name), path!).replace(/\.js$/, ".d.ts");
      if (target.startsWith(resolve("package") + "/")) assert.ok(names.includes(target.slice(process.cwd().length + 1)), `missing declaration: ${name} -> ${path}`);
    }
  }
  let unpackedBytes = 0, runtimeBytes = 0;
  for (const name of names) {
    const bytes = (await readFile(resolve(directory, name))).length;
    unpackedBytes += bytes;
    // What a Worker can load: the kernel and auth modules, never the generator or CLI.
    if (/^package\/dist\/(?:kernel|auth)\/.+\.js$/.test(name)) runtimeBytes += bytes;
  }
  const tarballBytes = (await stat(archive)).size;
  console.log(JSON.stringify({gate:"package",files:names.length,tarballBytes,unpackedBytes,runtimeBytes}));
  const budget = JSON.parse(await readFile(resolve(import.meta.dir, "../size-budgets.json"), "utf8")).runtime;
  // Sizes are reported, not gating (#1465, 2026-10-13): cold-start behaviour is gated by the startup-graph and
  // per-surface startup budgets in check-size.ts; package bytes are tracked per PR and slimmed deliberately.
  for (const [label, actual, limit] of [["runtime JavaScript", runtimeBytes, budget], ["packed package", tarballBytes, 100 * 1024], ["unpacked package", unpackedBytes, 384 * 1024]] as const)
    if (actual > limit) console.warn(`[size report] ${label} ${actual} B exceeds the reference ${limit} B`);
} finally { await rm(directory, {recursive:true,force:true}); }
