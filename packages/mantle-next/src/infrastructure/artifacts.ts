import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GENERATED } from "../domain/artifacts.js";

/** Only marked generated files (and pre-header operation entries) can be removed. */
async function ownedFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await ownedFiles(directory, name));
    else if (entry.isFile() && /\.(ts|sql)$/.test(name)) {
      const source = await readFile(join(directory, name), "utf8");
      if (source.startsWith(`// ${GENERATED}\n`) || source.startsWith(`-- ${GENERATED}\n`) ||
        /^(?:views|procedures)[/\\]/.test(name) && /^import \{ (?:view|procedure)_[A-Za-z0-9$]+ as operation \} from "\.\.\/generated\.js";\nexport default operation;/.test(source)) files.push(name);
    }
  }
  return files;
}

/** Check never writes; normal generation removes obsolete SDK-owned files only. */
export async function writeArtifacts(directory: string, files: Readonly<Record<string, string>>, check = false): Promise<string[]> {
  const changed: string[] = [];
  for (const [name, source] of Object.entries(files)) {
    const path = join(directory, name);
    const previous = await readFile(path, "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previous === source) continue;
    changed.push(path);
    if (!check) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
  }
  for (const name of await ownedFiles(directory)) {
    if (Object.hasOwn(files, name.replaceAll("\\", "/"))) continue;
    changed.push(join(directory, name));
    if (!check) await rm(join(directory, name));
  }
  return changed.sort();
}
