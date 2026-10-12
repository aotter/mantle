#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureWrangler } from "./wrangler.js";
import type { Target } from "../domain/model.js";

const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const usage = "Usage: mantle generate <target> <output-directory> <manifest>... [--auth <module>] [--wrangler <path>] [--entry <worker entry>] [--outdir <bundle directory>]\n       mantle bundle <entry> <outdir>";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    auth: { type: "string" }, wrangler: { type: "string" }, entry: { type: "string", default: "src/worker.ts" }, outdir: { type: "string", default: "dist" },
  } });
  const command = positionals[0] === "bundle" || positionals[0] === "generate" ? positionals.shift()! : "generate";
  if (command === "bundle") {
    const [entry, outdir] = positionals;
    if (!entry || !outdir || positionals.length !== 2 || values.auth || values.wrangler) throw new Error(usage);
    await (await import("./bundle.js")).bundle(entry, outdir);
  } else {
    const [target, destination, ...paths] = positionals;
    if (!target || !targets.includes(target as Target) || !destination || !paths.length) throw new Error(usage);
    const sources = await Promise.all(paths.map(async path => ({ sourceId: path, text: await readFile(path, "utf8") })));
    // Read plain options without constructing Better Auth, which can touch the database.
    const loaded = values.auth ? await import(pathToFileURL(resolve(values.auth)).href) : undefined;
    const auth = loaded && (loaded.authOptions?.(new Proxy({}, { get: () => undefined })) ?? loaded.auth?.options);
    if (values.auth && !auth) throw new Error(`${values.auth} must export \`authOptions(env)\` (or \`auth\`, a betterAuth() instance).`);
    const { generateFromSources } = await import("./generate.js");
    const result = await generateFromSources({ target: target as Target, sources: { sources }, auth });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
    await mkdir(destination, { recursive: true });
    for (const [name, source] of Object.entries(result.files)) {
      await mkdir(dirname(resolve(destination, name)), { recursive: true });
      await writeFile(resolve(destination, name), source);
    }
    if (target.startsWith("cloudflare-")) {
      const wrangler = values.wrangler ?? ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find(existsSync) ?? "wrangler.jsonc";
      configureWrangler(wrangler, values.entry!, values.outdir!, destination);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
