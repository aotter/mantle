#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureWrangler } from "./wrangler.js";
import { writeArtifacts } from "./artifacts.js";
import type { Target } from "../domain/model.js";

const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const usage = "Usage: mantle generate <target> <output-directory> <manifest>... [--check] [--admin] [--site <module>] [--auth <module>] [--admin-extensions <module>] [--wrangler <path>] [--entry <worker entry>] [--outdir <bundle directory>]\n       mantle bundle <entry> <outdir>\n       mantle describe [<target>] <manifest>... [--json] [--diff <old.json>]";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: "boolean" }, diff: { type: "string" }, check: { type: "boolean" }, admin: { type: "boolean" }, site: { type: "string" }, "admin-extensions": { type: "string" }, auth: { type: "string" }, wrangler: { type: "string" }, entry: { type: "string", default: "src/worker.ts" }, outdir: { type: "string", default: "dist" },
  } });
  const command = positionals[0] === "bundle" || positionals[0] === "generate" || positionals[0] === "describe" ? positionals.shift()! : "generate";
  if (command === "describe") {
    const target = targets.includes(positionals[0] as Target) ? positionals.shift()! : "bun-sqlite";
    if (!positionals.length) throw new Error(usage);
    const { compilePlan, sqliteCompiler, postgresCompiler } = await import("../build/compiler.js");
    const { describeApp, diffApp } = await import("../domain/describe/index.js");
    const sources = await Promise.all(positionals.map(async path => ({ sourceId: path, text: await readFile(path, "utf8") })));
    const compiled = await compilePlan({ sources }, target.endsWith("postgres") ? postgresCompiler : sqliteCompiler, "operational");
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics, null, 2));
    const report = await describeApp(compiled.plan);
    if (values.diff) {
      const changes = diffApp(JSON.parse(await readFile(values.diff, "utf8")), report);
      console.log(values.json ? JSON.stringify(changes, null, 2) : changes.map(c => `${c.direction}: ${c.id} ${c.field}`).join("\n") || "No changes.");
    } else if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Plan ${report.planHash} (schemaVersion ${report.schemaVersion})`);
      for (const [name, field] of Object.entries(report.access)) console.log(`Field ${name}: ${field.type} ${field.op}${field.enum ? ` enum=${JSON.stringify(field.enum)}` : ""}; scope=${field.scope.join(",")}; restrict=${field.restrict.join(",")}`);
      for (const t of report.targets) {
        const m = t._meta;
        console.log(`${m.id} [${m.surface}] ${m.readOnly ? "readOnly" : "writes or custom code"}${["opaque", "ownerScoped", "unscopedReads", "hostCallable"].filter(k => m[k as keyof typeof m]).map(k => ` ${k}`).join("")} requires=${JSON.stringify(m.requires)}`);
        console.log(`  scope=${JSON.stringify(m.scope)} restrict=${JSON.stringify(m.restrict)} fields=${JSON.stringify(m.userFields)}`);
      }
    }
  } else if (command === "bundle") {
    const [entry, outdir] = positionals;
    if (!entry || !outdir || positionals.length !== 2 || values.admin || values.site || values.auth || values["admin-extensions"] || values.wrangler || values.check) throw new Error(usage);
    await (await import("./bundle.js")).bundle(entry, outdir);
  } else {
    const [target, destination, ...paths] = positionals;
    if (!target || !targets.includes(target as Target) || !destination || !paths.length) throw new Error(usage);
    const sources = await Promise.all(paths.map(async path => ({ sourceId: path, text: await readFile(path, "utf8") })));
    // Read plain options without constructing Better Auth, which can touch the database.
    const loaded = values.auth ? await import(pathToFileURL(resolve(values.auth)).href) : undefined;
    const auth = loaded && (loaded.authOptions?.(new Proxy({}, { get: () => undefined })) ?? loaded.auth?.options);
    if (values.auth && !auth) throw new Error(`${values.auth} must export \`authOptions(env)\` (or \`auth\`, a betterAuth() instance).`);
    const site = values.site ? (await import(pathToFileURL(resolve(values.site)).href)).siteDefaults : undefined;
    if (values.site && !site) throw new Error(`${values.site} must export siteDefaults.`);
    const extensionModule = values["admin-extensions"] ? await import(pathToFileURL(resolve(values["admin-extensions"])).href) : undefined;
    const adminExtensions = extensionModule?.adminExtensions ?? extensionModule?.default;
    if (values["admin-extensions"] && !Array.isArray(adminExtensions)) throw new Error(`${values["admin-extensions"]} must export an adminExtensions array (named or default).`);
    const { generateFromSources } = await (values.auth ? import("./generateAuth.js") : import("./generate.js"));
    const result = await generateFromSources({ target: target as Target, sources: { sources }, admin:values.admin, auth, site, adminExtensions });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    for (const warning of result.warnings ?? []) console.warn(`warning: ${warning}`);
    const changed = await writeArtifacts(destination, result.files, values.check);
    if (target.startsWith("cloudflare-")) {
      const wrangler = values.wrangler ?? ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find(existsSync) ?? "wrangler.jsonc";
      if (configureWrangler(wrangler, values.entry!, values.outdir!, destination, values.check)) changed.push(wrangler);
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
