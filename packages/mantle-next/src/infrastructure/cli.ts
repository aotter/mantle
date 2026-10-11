import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateFromSources } from "./generate.js";
import type { Target } from "../domain/model.js";
const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const args = process.argv.slice(2);
// --auth <module>: the module exporting the application's `auth` (a betterAuth() instance); its tables join schema.sql.
const at = args.indexOf("--auth");
const authModule = at >= 0 ? args.splice(at, 2)[1] : undefined;
const [target, destination, ...paths] = args;
if (!targets.includes(target as Target) || !destination || !paths.length) {
  console.error("Usage: mantle-next <bun-sqlite|bun-postgres|cloudflare-d1|cloudflare-postgres> <output-directory> <manifest>... [--auth <module>]");
  process.exitCode = 1;
} else {
  const sources = await Promise.all(paths.map(async (path) => ({ sourceId: path, text: await readFile(path, "utf8") })));
  // `auth` (a betterAuth() instance) or `createAuth(env)`: the tables depend on plugins and options, never on env values.
  const loaded = authModule ? await import(pathToFileURL(resolve(authModule)).href) : undefined;
  const auth = loaded && (loaded.auth ?? loaded.createAuth?.(new Proxy({}, { get: () => undefined })))?.options;
  if (authModule && !auth) throw new Error(`${authModule} must export \`auth\` (a betterAuth() instance) or \`createAuth(env)\`.`);
  const result = await generateFromSources({ target: target as Target, sources: { sources }, auth });
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
