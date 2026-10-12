/** Inspect the actual tarball, not package.json's intended inclusion list. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const directory = await mkdtemp(resolve(tmpdir(), "mantle-next-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd:resolve(import.meta.dir,".."), stdio:"pipe" });
  const archive = resolve(directory, (await readdir(directory)).find(name => name.endsWith(".tgz"))!);
  const names = execFileSync("tar", ["-tzf", archive], {encoding:"utf8"}).trim().split("\n");
  const allowed = /^package\/(?:package\.json|README\.md|LICENSE|dist\/[A-Za-z0-9_/-]+\.(?:js|d\.ts))$/;
  assert.ok(names.every(name => allowed.test(name)), `unexpected package files: ${names.filter(name => !allowed.test(name))}`);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  const packed = resolve(directory, "package");
  for (const name of names.filter(name => name.endsWith(".d.ts"))) {
    const source = await readFile(resolve(directory, name), "utf8");
    for (const imported of ts.preProcessFile(source).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = resolve(dirname(resolve(directory, name)), imported.fileName).replace(/\.js$/, ".d.ts");
      assert.ok(names.some(file => resolve(directory, file) === target), `missing declaration: ${name} -> ${imported.fileName}`);
    }
  }
  await symlink(resolve(import.meta.dir, "../node_modules"), resolve(directory, "node_modules"), "dir");
  const manifest = JSON.parse(await readFile(resolve(packed, "package.json"), "utf8"));
  const consumer = resolve(directory, "consumer.mts");
  await writeFile(consumer, Object.values(manifest.exports).map((entry, i) => `export type Entry${i} = typeof import(${JSON.stringify("./package/" + String(entry).replace(/^\.\//, ""))});`).join("\n"));
  const program = ts.createProgram([consumer], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node", "bun-types"], typeRoots: [resolve(directory, "node_modules/@types"), resolve(directory, "node_modules")] });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, " ")), [], "packed public entries must typecheck");
  let unpackedBytes = 0;
  for (const name of names) unpackedBytes += (await readFile(resolve(directory, name))).length;
  const tarballBytes = (await stat(archive)).size;
  console.log(JSON.stringify({gate:"package",files:names.length,tarballBytes,unpackedBytes}));
  assert.ok(tarballBytes <= 48 * 1024, "packed package exceeds 48 KiB");
  assert.ok(unpackedBytes <= 128 * 1024, "unpacked package exceeds 128 KiB");
} finally { await rm(directory, {recursive:true,force:true}); }
