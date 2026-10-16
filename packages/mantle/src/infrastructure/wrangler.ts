import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const requiredFlags = ["nodejs_compat", "global_fetch_strictly_public"];

/** Newest date the project's installed workerd supports, as create-cloudflare picks it; a fixed date before Wrangler is installed. */
function compatibilityDate(dir: string): string {
  try {
    let from = join(dir, "package.json");
    for (const name of ["wrangler", "miniflare", "workerd"]) from = createRequire(from).resolve(`${name}/package.json`);
    const [, y, m, d] = /^\d+\.(\d{4})(\d{2})(\d{2})\./.exec(JSON.parse(readFileSync(from, "utf8")).version) ?? [];
    if (y) return `${y}-${m}-${d}`;
  } catch {}
  return "2026-09-28";
}

/** `assets`: with `--admin`, the static assets directory `mantle bundle` builds Admin into (`<assets>/admin`). */
export function configureWrangler(configPath: string, entry: string, outdir: string, generated: string, check = false, assets?: string, publicFetchRequired = false): boolean {
  const configDir = dirname(resolve(configPath));
  const local = (path: string) => relative(configDir, resolve(path)).replaceAll("\\", "/") || ".";
  const output = local(outdir);
  const quote = (arg: string) => /^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
  const worker = `${output}/worker`;
  const assetsFlag = assets !== undefined && resolve(assets) !== resolve(outdir, "client") ? ` --assets ${quote(assets)}` : "";
  const keys = {
    main: `${worker}/${basename(entry).replace(/\.[^.]+$/, "")}.js`, no_bundle: true,
    find_additional_modules: true, base_dir: worker,
    rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
    build: { command: `mantle bundle ${quote(entry)} ${quote(outdir)}${assetsFlag}`, watch_dir: [local(dirname(entry)), local(generated)] },
  };
  if (configPath.endsWith(".toml")) {
    if (check) throw new Error("--check requires a JSON or JSONC Wrangler config; TOML generation only prints manual edits.");
    console.log(`Leave ${configPath} unchanged. Add these Wrangler TOML keys (include nodejs_compat and global_fetch_strictly_public in every compatibility_flags override):\n` +
      `main = ${JSON.stringify(keys.main)}\nno_bundle = true\nfind_additional_modules = true\nbase_dir = ${JSON.stringify(worker)}\ncompatibility_flags = ${JSON.stringify(requiredFlags)}\n\n` +
      (assets === undefined ? "" : `[assets]\ndirectory = ${JSON.stringify(local(assets))}\n\n`) +
      `[[rules]]\ntype = "ESModule"\nglobs = ["**/*.js"]\nfallthrough = true\n\n[build]\ncommand = ${JSON.stringify(keys.build.command)}\nwatch_dir = ${JSON.stringify(keys.build.watch_dir)}`);
    return false;
  }
  const exists = existsSync(configPath);
  const original = exists ? readFileSync(configPath, "utf8") : JSON.stringify({ name: "your-worker-name", compatibility_date: compatibilityDate(configDir) }, null, 2) + "\n";
  let text = original;
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${configPath} must be a valid JSONC object.`);
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  // Merge, never replace: the user's own module rules and build options survive.
  const { rules: [rule], build: buildKeys, ...top } = keys;
  const edit = (path: (string | number)[], value: unknown) => {
    if (!isDeepStrictEqual(path.reduce((v: any, k) => v?.[k], config), value)) text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  };
  // Public routing is the default; an explicit private origin remains app-owned without OAuth/CIMD.
  const ensureFlags = (path: (string | number)[], flags: unknown) => {
    if (flags !== undefined && (!Array.isArray(flags) || !flags.every(flag => typeof flag === "string"))) throw new Error(`${configPath}: ${path.join(".")} must be an array of strings.`);
    const privateFetch = Array.isArray(flags) && flags.includes("global_fetch_private_origin");
    if (privateFetch && (publicFetchRequired || flags.includes("global_fetch_strictly_public"))) throw new Error(`${configPath}: ${path.join(".")} includes global_fetch_private_origin, which conflicts with public OAuth/CIMD fetch routing. Remove it and use global_fetch_strictly_public.`);
    const required = privateFetch ? ["nodejs_compat"] : requiredFlags;
    if (flags === undefined) edit(path, required);
    else for (const flag of required) if (!(flags as string[]).includes(flag)) edit([...path, -1], flag);
  };
  ensureFlags(["compatibility_flags"], config.compatibility_flags);
  // Wrangler environment arrays replace the top-level flags rather than inheriting them.
  for (const [name, environment] of Object.entries(config.env ?? {}) as [string, any][]) {
    if (environment?.compatibility_flags !== undefined) ensureFlags(["env", name, "compatibility_flags"], environment.compatibility_flags);
  }
  for (const [key, value] of Object.entries(top)) edit([key], value);
  for (const [key, value] of Object.entries(buildKeys)) edit(["build", key], value);
  // Only the directory: the binding, run_worker_first and html_handling stay the application's.
  if (assets !== undefined) edit(["assets", "directory"], local(assets));
  if (!(config.rules ?? []).some((r: unknown) => isDeepStrictEqual(r, rule))) edit(config.rules === undefined ? ["rules"] : ["rules", -1], config.rules === undefined ? [rule] : rule);
  const changed = !exists || text !== original;
  if (changed && !check) writeFileSync(configPath, text);
  if (!exists && !check) console.log(`Created ${configPath}. Set name and compatibility_date for your Worker, and add your D1/Hyperdrive bindings and other application settings.`);
  return changed;
}
