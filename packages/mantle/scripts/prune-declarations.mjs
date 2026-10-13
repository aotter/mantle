/** Publish declarations only for the package's exports and what they reference; generator internals ship as JavaScript only. */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."), dist = join(root, "dist");
const exports = Object.values(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports).filter(target => typeof target === "string" && target.endsWith(".js"));
const keep = new Set(), pending = exports.map(target => resolve(root, target.replace(/\.js$/, ".d.ts")));
while (pending.length) {
  const file = pending.pop();
  if (keep.has(file)) continue;
  keep.add(file);
  for (const [, path] of readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) pending.push(resolve(dirname(file), path.replace(/\.js$/, ".d.ts")));
}
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
for (const file of walk(dist)) if (file.endsWith(".d.ts") && !keep.has(file)) rmSync(file);
