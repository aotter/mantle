#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureWrangler } from "./wrangler.js";
import { writeArtifacts } from "./artifacts.js";
import { INPUTS_FILE, inputsFingerprint } from "./inputs.js";
import type { Target } from "../domain/model.js";

/** Option modules are often .ts, which older Node rejects with a bare "Unknown file extension". */
async function load(path: string) {
  try { return await import(pathToFileURL(resolve(path)).href); }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_UNKNOWN_FILE_EXTENSION") throw new Error(`Cannot load ${path}: Node ${process.versions.node} does not run TypeScript. Use Node 22.22 or later, as the package engines say.`);
    throw error;
  }
}
const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const usage = "Usage: mantle help [topic]   (start here: the installed docs, one topic at a time)\n       mantle init [directory] [--dry-run]\n       mantle generate <target> <output-directory> <manifest>... [--check] [--admin] [--site <module>] [--auth <module>]... (one per Better Auth instance) [--wrangler <path>] [--entry <worker entry>] [--outdir <bundle directory>] [--assets <static assets directory>]\n       mantle bundle <entry> <outdir> [--assets <static assets directory>]\n       mantle describe <target> <manifest>... [--diff <old.json>]";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    diff: { type: "string" }, check: { type: "boolean" }, admin: { type: "boolean" }, site: { type: "string" }, auth: { type: "string", multiple: true }, wrangler: { type: "string" }, entry: { type: "string", default: "src/worker.ts" }, outdir: { type: "string", default: "dist" }, assets: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  const named = ["bundle", "generate", "describe", "help", "init"].includes(positionals[0]!) ? positionals.shift()! : undefined;
  // `-h` prints usage and never runs a command; bare `mantle` starts at help, but options with no positionals stay a usage error.
  const command = values.help ? "usage" : named ?? (process.argv.length > 2 ? "generate" : "help");
  if (command === "usage") console.log(`${usage}\n\nStart with mantle help: the installed docs, one topic at a time.`);
  else if (command === "help") {
    const { help, topicList } = await import("./help.js");
    if (positionals.length > 1) throw new Error(usage);
    console.log(positionals[0] === "topics" ? topicList() : help(positionals[0]));
  } else if (command === "init") {
    if (positionals.length > 1) throw new Error(usage);
    console.log((await import("./init.js")).init(positionals[0] ?? ".", values["dry-run"]));
  } else if (command === "describe") {
    const target = positionals.shift();
    if (!target || !targets.includes(target as Target) || !positionals.length) throw new Error(usage);
    const { compilePlan, sqliteCompiler, postgresCompiler } = await import("../build/compiler.js");
    const { describeApp, diffApp } = await import("../domain/describe/index.js");
    const sources = await Promise.all(positionals.map(async path => ({ sourceId: path, text: await readFile(path, "utf8") })));
    const compiled = await compilePlan({ sources }, target.endsWith("postgres") ? postgresCompiler : sqliteCompiler, "operational");
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics, null, 2));
    const report = await describeApp(compiled.plan);
    if (values.diff) {
      const changes = diffApp(JSON.parse(await readFile(values.diff, "utf8")), report);
      console.log(JSON.stringify(changes, null, 2));
    } else console.log(JSON.stringify(report, null, 2));
  } else if (command === "bundle") {
    const [entry, outdir] = positionals;
    if (!entry || !outdir || positionals.length !== 2 || values.admin || values.site || values.auth || values.wrangler || values.check) throw new Error(usage);
    await (await import("./bundle.js")).bundleApp(entry, outdir, values.assets);
  } else {
    const [target, destination, ...paths] = positionals;
    if (!target || !targets.includes(target as Target) || !destination || !paths.length) throw new Error(usage);
    // A shell leaves an unmatched glob as is; say what is missing instead of ENOENT.
    for (const path of paths) if (/[*?]/.test(path) && !existsSync(path)) throw new Error(`No manifest matches ${path}. Add one (mantle help four-atoms, mantle help manifest), then run generate again.`);
    const sources = await Promise.all(paths.map(async path => ({ sourceId: path, text: await readFile(path, "utf8") })));
    // Read plain options without constructing Better Auth, which can touch the database.
    // One --auth per Better Auth instance; their tables are merged into one migration.
    const auth = await Promise.all((values.auth ?? []).map(async path => {
      const loaded = await load(path);
      const options = loaded.authOptions?.(new Proxy({}, { get: () => undefined })) ?? loaded.auth?.options;
      if (!options) throw new Error(`${path} must export \`authOptions(env)\` (or \`auth\`, a betterAuth() instance).`);
      return options;
    }));
    const site = values.site ? (await load(values.site)).siteDefaults : undefined;
    if (values.site && !site) throw new Error(`${values.site} must export siteDefaults.`);
    const { generateFromSources } = await (auth.length ? import("./generateAuth.js") : import("./generate.js"));
    const result = await generateFromSources({ target: target as Target, sources: { sources }, admin:values.admin, auth, site });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    for (const warning of result.warnings ?? []) console.warn(`warning: ${warning}`);
    const read = [...paths, ...(values.auth ?? []), ...(values.site ? [values.site] : [])];
    const changed = await writeArtifacts(destination, { ...result.files, [INPUTS_FILE]: inputsFingerprint(destination, read, target) }, values.check);
    // After writing: the entry's imports of generated modules only resolve once they exist.
    for (const warning of await (await import("./mounts.js")).unmountedWarnings(values.entry!, destination, result.files)) console.warn(`warning: ${warning}`);
    if (target.startsWith("cloudflare-")) {
      const wrangler = values.wrangler ?? ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find(existsSync) ?? "wrangler.jsonc";
      const assets = values.admin ? values.assets ?? join(values.outdir!, "client") : undefined;
      const publicFetchRequired = auth.some(options => options.plugins?.some((plugin: { id: string }) => plugin.id === "oauth-provider" || plugin.id === "cimd"));
      if (configureWrangler(wrangler, values.entry!, values.outdir!, destination, values.check, assets, publicFetchRequired)) changed.push(wrangler);
    }
    if (values.check && changed.length) throw new Error(`Generated output is stale. Run mantle generate with the same options:\n${changed.join("\n")}`);
    if (!values.check) console.log(`Commit generated output and Wrangler config edits; keep dist/ untracked. Add to .gitattributes: ${JSON.stringify(relative(process.cwd(), resolve(destination)).replaceAll("\\", "/") + "/**")} linguist-generated=true`);
    // A contract, not a to-do: the CLI does not read the app's handlers; tsc checks them against Handlers.
    if (!values.check && result.refProcedures.length) console.log(`Ref Procedures need these Handlers keys (tsc --noEmit checks them; pass them at store(db, caller, { handlers })): ${result.refProcedures.map(name => JSON.stringify(name)).join(", ")}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
