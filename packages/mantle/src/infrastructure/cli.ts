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
const usage = "Usage: mantle generate <target> <output-directory> <manifest>... [--check] [--admin] [--site <module>] [--auth <module>]... (one per Better Auth instance) [--admin-extensions <module>] [--wrangler <path>] [--entry <worker entry>] [--outdir <bundle directory>] [--assets <static assets directory>]\n       mantle bundle <entry> <outdir> [--assets <static assets directory>]\n       mantle describe <target> <manifest>... [--diff <old.json>]";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    diff: { type: "string" }, check: { type: "boolean" }, admin: { type: "boolean" }, site: { type: "string" }, "admin-extensions": { type: "string" }, auth: { type: "string", multiple: true }, wrangler: { type: "string" }, entry: { type: "string", default: "src/worker.ts" }, outdir: { type: "string", default: "dist" }, assets: { type: "string" },
  } });
  const command = positionals[0] === "bundle" || positionals[0] === "generate" || positionals[0] === "describe" ? positionals.shift()! : "generate";
  if (command === "describe") {
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
    if (!entry || !outdir || positionals.length !== 2 || values.admin || values.site || values.auth || values["admin-extensions"] || values.wrangler || values.check) throw new Error(usage);
    await (await import("./bundle.js")).bundleApp(entry, outdir, values.assets);
  } else {
    const [target, destination, ...paths] = positionals;
    if (!target || !targets.includes(target as Target) || !destination || !paths.length) throw new Error(usage);
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
    const extensionModule = values["admin-extensions"] ? await load(values["admin-extensions"]) : undefined;
    // The Admin presentation module: extensions and/or the project's sidebar groups.
    const adminExtensions = extensionModule?.adminExtensions ?? extensionModule?.default ?? (extensionModule?.navGroups ? [] : undefined);
    const navGroups = extensionModule?.navGroups;
    if (values["admin-extensions"] && !Array.isArray(adminExtensions)) throw new Error(`${values["admin-extensions"]} must export an adminExtensions array (named or default) or navGroups.`);
    const { generateFromSources } = await (auth.length ? import("./generateAuth.js") : import("./generate.js"));
    const result = await generateFromSources({ target: target as Target, sources: { sources }, admin:values.admin, auth, site, adminExtensions, navGroups });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    for (const warning of result.warnings ?? []) console.warn(`warning: ${warning}`);
    const read = [...paths, ...(values.auth ?? []), ...[values.site, values["admin-extensions"]].filter((path): path is string => !!path)];
    const changed = await writeArtifacts(destination, { ...result.files, [INPUTS_FILE]: inputsFingerprint(destination, read, target) }, values.check);
    if (target.startsWith("cloudflare-")) {
      const wrangler = values.wrangler ?? ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find(existsSync) ?? "wrangler.jsonc";
      const assets = values.admin ? values.assets ?? join(values.outdir!, "client") : undefined;
      if (configureWrangler(wrangler, values.entry!, values.outdir!, destination, values.check, assets)) changed.push(wrangler);
    }
    if (values.check && changed.length) throw new Error(`Generated output is stale. Run mantle generate with the same options:\n${changed.join("\n")}`);
    if (!values.check) console.log(`Commit generated output and Wrangler config edits; keep dist/ untracked. Add to .gitattributes: ${JSON.stringify(relative(process.cwd(), resolve(destination)).replaceAll("\\", "/") + "/**")} linguist-generated=true`);
    for (const name of result.refProcedures) console.log(`Ref Procedure ${JSON.stringify(name)}: implement Handlers[${JSON.stringify(name)}].`);
    if (result.refProcedures.length) console.log("Next: run tsc --noEmit; pass the handlers at store(db, caller, { handlers }).");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
