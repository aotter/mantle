/** Shared helpers: generate a fixture app and run its code from source. Generated code imports `@aotter/mantle-next/<kernel module>`; here those are the sources. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateFromSources } from "../../src/infrastructure/generate.js";
import type { Target } from "../../src/domain/model.js";

type Sources = { sourceId: string; text: string }[];
export const link = (code: string) => code.replace(/"@aotter\/mantle-next\/([^"]+)"/g, (_, path) => JSON.stringify(resolve(import.meta.dir, "../../src/kernel", path + ".ts")));
/** Fixture manifests by file name (the purchase app by default). */
export const loadFixtureSources = (...names: string[]): Promise<Sources> =>
  Promise.all((names.length ? names : ["purchase.yaml"]).map(async name => ({ sourceId: name, text: await readFile(resolve(import.meta.dir, name), "utf8") })));
export async function generateOrThrow(target: Target, sources: Sources): Promise<Readonly<Record<string, string>>> {
  const generated = await generateFromSources({ target, sources: { sources } });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  return generated.files;
}
/** Writes generated files under `dir`, TypeScript linked to the sources unless `linked` is false (then it resolves the package, i.e. `dist`). */
export async function writeGenerated(dir: string, files: Readonly<Record<string, string>>, linked = true): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(dir, name)), { recursive: true });
    await writeFile(resolve(dir, name), linked && name.endsWith(".ts") ? link(text) : text);
  }
}
/** Keep lazy operation modules available until the test file has finished. */
const loadedDirectories: string[] = [];
export const cleanupGenerated = () => Promise.all(loadedDirectories.map(dir => rm(dir, { recursive: true, force: true })));
export async function loadGenerated(files: Readonly<Record<string, string>>): Promise<any> {
  const dir = resolve(import.meta.dir, ".generated", crypto.randomUUID());
  loadedDirectories.push(dir);
  await writeGenerated(dir, files);
  return import(resolve(dir, "generated.ts"));
}
