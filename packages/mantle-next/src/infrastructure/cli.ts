import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateFromSources } from "./generate.js";
import type { Target } from "../domain/model.js";
const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const args = process.argv.slice(2);
const checked = args.includes("--checked");
const [target, destination, ...paths] = args.filter(arg => arg !== "--checked");
if (!targets.includes(target as Target) || !destination || !paths.length) {
  console.error("Usage: mantle-next <bun-sqlite|bun-postgres|cloudflare-d1|cloudflare-postgres> <output-directory> <manifest>... [--checked]");
  process.exitCode = 1;
} else {
  const sources = await Promise.all(paths.map(async (path) => ({ sourceId: path, text: await readFile(path, "utf8") })));
  const result = await generateFromSources({ target: target as Target, sources: { sources }, checked });
  if (!result.ok) {
    console.error(JSON.stringify(result.diagnostics, null, 2));
    process.exitCode = 1;
  } else {
    // Disabling the optional surface must not leave executable stale SQL/auth.
    if (!checked) {
      const obsolete = resolve(destination, "checked.ts");
      const source = await readFile(obsolete,"utf8").catch((error:NodeJS.ErrnoException) => { if(error.code === "ENOENT") return undefined; throw error; });
      if (source !== undefined) {
        if (!source.startsWith("// Generated checked SQL.") && !source.startsWith("// Generated native application SQL."))
          throw new Error("Refusing to remove application-owned checked.ts; use a fresh output directory.");
        await unlink(obsolete);
      }
    }
    await mkdir(destination, { recursive: true });
    for (const [name, source] of Object.entries(result.files)) {
      await mkdir(dirname(resolve(destination, name)), { recursive: true });
      await writeFile(resolve(destination, name), source);
    }
  }
}
