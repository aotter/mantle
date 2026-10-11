/** Inspect the actual tarball, not package.json's intended inclusion list. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const directory = await mkdtemp(resolve(tmpdir(), "mantle-next-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd:resolve(import.meta.dir,".."), stdio:"pipe" });
  const archive = resolve(directory, (await readdir(directory)).find(name => name.endsWith(".tgz"))!);
  const names = execFileSync("tar", ["-tzf", archive], {encoding:"utf8"}).trim().split("\n");
  const allowed = /^package\/(?:package\.json|README\.md|LICENSE|dist\/[A-Za-z0-9_/-]+\.(?:js|d\.ts))$/;
  assert.ok(names.every(name => allowed.test(name)), `unexpected package files: ${names.filter(name => !allowed.test(name))}`);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  let unpackedBytes = 0;
  for (const name of names) unpackedBytes += (await readFile(resolve(directory, name))).length;
  const tarballBytes = (await stat(archive)).size;
  console.log(JSON.stringify({gate:"package",files:names.length,tarballBytes,unpackedBytes}));
  assert.ok(tarballBytes <= 40 * 1024, "packed package exceeds 40 KiB");
  assert.ok(unpackedBytes <= 96 * 1024, "unpacked package exceeds 96 KiB");
} finally { await rm(directory, {recursive:true,force:true}); }
