import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export function configureWrangler(configPath: string, entry: string, outdir: string, generated: string): void {
  const configDir = dirname(resolve(configPath));
  const local = (path: string) => relative(configDir, resolve(path)).replaceAll("\\", "/") || ".";
  const output = local(outdir);
  const quote = (arg: string) => /^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
  const keys = {
    main: `${output}/${basename(entry).replace(/\.[^.]+$/, "")}.js`, no_bundle: true,
    find_additional_modules: true, base_dir: output,
    rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
    build: { command: `mantle bundle ${quote(entry)} ${quote(outdir)}`, watch_dir: [local(dirname(entry)), local(generated)] },
  };
  if (configPath.endsWith(".toml")) {
    console.log(`Leave ${configPath} unchanged. Add these Wrangler TOML keys (include nodejs_compat in any existing compatibility_flags):\n` +
      `main = ${JSON.stringify(keys.main)}\nno_bundle = true\nfind_additional_modules = true\nbase_dir = ${JSON.stringify(output)}\ncompatibility_flags = ["nodejs_compat"]\n\n` +
      `[[rules]]\ntype = "ESModule"\nglobs = ["**/*.js"]\nfallthrough = true\n\n[build]\ncommand = ${JSON.stringify(keys.build.command)}\nwatch_dir = ${JSON.stringify(keys.build.watch_dir)}`);
    return;
  }
  const exists = existsSync(configPath);
  let text = exists ? readFileSync(configPath, "utf8") : JSON.stringify({ name: "your-worker-name", compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"] }, null, 2) + "\n";
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${configPath} must be a valid JSONC object.`);
  if (config.compatibility_flags !== undefined && (!Array.isArray(config.compatibility_flags) || !config.compatibility_flags.every((flag: unknown) => typeof flag === "string"))) {
    throw new Error(`${configPath}: compatibility_flags must be an array of strings.`);
  }
  const flags: string[] = config.compatibility_flags ?? [];
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  for (const [key, value] of Object.entries(keys)) {
    if (JSON.stringify(config[key]) !== JSON.stringify(value)) text = applyEdits(text, modify(text, [key], value, { formattingOptions }));
  }
  if (!flags.includes("nodejs_compat")) {
    const path = config.compatibility_flags === undefined ? ["compatibility_flags"] : ["compatibility_flags", -1];
    text = applyEdits(text, modify(text, path, config.compatibility_flags === undefined ? ["nodejs_compat"] : "nodejs_compat", { formattingOptions }));
  }
  if (!exists || text !== readFileSync(configPath, "utf8")) writeFileSync(configPath, text);
  if (!exists) console.log(`Created ${configPath}. Set name and compatibility_date for your Worker, and add your D1/Hyperdrive bindings and other application settings.`);
}
