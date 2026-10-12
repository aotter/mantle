#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureWrangler } from "./wrangler.js";
import type { Target } from "../domain/model.js";

const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const usage = "Usage: mantle generate <target> <output-directory> <manifest>... [--site <module>] [--auth <module>] [--admin-extensions <module>] [--wrangler <path>] [--entry <worker entry>] [--outdir <bundle directory>]\n       mantle bundle <entry> <outdir>";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    site: { type: "string" }, "admin-extensions": { type: "string" }, auth: { type: "string" }, wrangler: { type: "string" }, entry: { type: "string", default: "src/worker.ts" }, outdir: { type: "string", default: "dist" },
  } });
  const command = ["bundle", "generate", "export", "import"].includes(positionals[0]!) ? positionals.shift()! : "generate";
  if (command === "export" || command === "import") {
    await (await import("./transfer.js")).transfer(command, positionals);
  } else if (command === "bundle") {
    const [entry, outdir] = positionals;
    if (!entry || !outdir || positionals.length !== 2 || values.site || values.auth || values["admin-extensions"] || values.wrangler) throw new Error(usage);
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
    const { generateFromSources } = await import("./generate.js");
    const result = await generateFromSources({ target: target as Target, sources: { sources }, auth, site, adminExtensions });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    await mkdir(destination, { recursive: true });
    for (const [name, source] of Object.entries(result.files)) {
      await mkdir(dirname(resolve(destination, name)), { recursive: true });
      await writeFile(resolve(destination, name), source);
    }
    // Remove only obsolete generated operations; application-owned files are left alone.
    for (const kind of ["views", "procedures"]) {
      const folder = resolve(destination, kind);
      if (!existsSync(folder)) continue;
      for (const name of await readdir(folder)) {
        if (!name.endsWith(".ts") || Object.hasOwn(result.files, `${kind}/${name}`)) continue;
        const file = resolve(folder, name);
        if (/^import \{ (?:view|procedure)_[A-Za-z0-9$]+ as operation \} from "\.\.\/generated\.js";\nexport default operation;/.test(await readFile(file, "utf8"))) await rm(file);
      }
    }
    if (target.startsWith("cloudflare-")) {
      const wrangler = values.wrangler ?? ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find(existsSync) ?? "wrangler.jsonc";
      configureWrangler(wrangler, values.entry!, values.outdir!, destination);
    }
    for (const name of result.refProcedures) console.log(`Ref Procedure ${JSON.stringify(name)}: implement Handlers[${JSON.stringify(name)}].`);
    if (result.refProcedures.length) console.log("Next: run tsc --noEmit; pass the handlers at store(db, caller, { handlers }).");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
