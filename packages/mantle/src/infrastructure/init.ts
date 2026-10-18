/** `mantle init`: copy the installed app shell once. The app owns every file afterwards; init never overwrites one. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { docsRoot, packageRoot } from "./help.js";

// Local state a docs checkout may hold after someone ran the shell in place; sync-package-docs excludes the same names.
const LOCAL = new Set(["node_modules", ".wrangler", ".dev.vars", "pnpm-lock.yaml", "generated", "dist"]);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => LOCAL.has(entry.name) ? []
    : entry.isDirectory() ? files(join(directory, entry.name)).map(file => join(entry.name, file)) : [entry.name]);
}

export function init(destination: string, dryRun = false): string {
  const shell = resolve(docsRoot(), "examples/app-shell");
  const sdk = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version: string };
  const target = resolve(destination);
  const all = files(shell);
  const existing = all.filter(file => existsSync(join(target, file)));
  if (existing.length) throw new Error(`mantle init writes the app shell once and never overwrites. These files already exist in ${target}:\n${existing.map(f => `  ${f}`).join("\n")}\nMove them aside or run mantle init in an empty directory; to use generated code inside an existing app, skip init and run mantle help typed-queries.`);
  const notes: string[] = [];
  for (const file of all) {
    let text = readFileSync(join(shell, file), "utf8");
    // Pin the shell's Mantle packages to the installed SDK.
    if (file === "package.json") {
      const pkg = JSON.parse(text);
      for (const name of Object.keys(pkg.dependencies)) if (name.startsWith("@aotter/mantle")) pkg.dependencies[name] = sdk.version;
      text = JSON.stringify(pkg, null, 2) + "\n";
    }
    if (!file.endsWith(".md")) text.split("\n").forEach((line, index) => { if (line.includes("AGENT:")) notes.push(`  ${file}:${index + 1}: ${line.slice(line.indexOf("AGENT:") + 6).trim()}`); });
    if (dryRun) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), text, { flag: "wx" });
  }
  if (!dryRun) mkdirSync(join(target, "manifests"), { recursive: true });
  const where = relative(process.cwd(), target) || ".";
  return [
    `${dryRun ? "Would write" : "Wrote"} the Mantle ${sdk.version} app shell to ${where}:`,
    ...all.map(file => `  ${file}`), "  manifests/",
    "",
    "AGENT: the app must fill in these before it is done (each is marked in the file):",
    "  manifests/*.yaml: the app's Schemas, Views, Procedures and Triggers (mantle help four-atoms)",
    ...notes,
    "",
    `Next: cd ${where} && pnpm install; then follow README.md. mantle help explains each step;`,
    "mantle help examples shows the patterns to take for each need. Accept with mantle help agent-workflow-acceptance before reporting done.",
  ].join("\n");
}
