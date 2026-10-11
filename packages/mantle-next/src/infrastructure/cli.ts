import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateFromSources } from "./generate.js";
import type { Target } from "../domain/model.js";
const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const [target, destination, ...paths] = process.argv.slice(2);
if (!targets.includes(target as Target) || !destination || !paths.length) {
  console.error("Usage: mantle-next <bun-sqlite|bun-postgres|cloudflare-d1|cloudflare-postgres> <output-directory> <manifest>...");
  process.exitCode = 1;
} else {
  const sources = await Promise.all(paths.map(async (path) => ({ sourceId: path, text: await readFile(path, "utf8") })));
  const result = await generateFromSources({ target: target as Target, sources: { sources } });
  if (!result.ok) {
    console.error(JSON.stringify(result.diagnostics, null, 2));
    process.exitCode = 1;
  } else {
    await mkdir(destination, { recursive: true });
    for (const [name, source] of Object.entries(result.files)) {
      await mkdir(dirname(resolve(destination, name)), { recursive: true });
      await writeFile(resolve(destination, name), source);
    }
  }
}
