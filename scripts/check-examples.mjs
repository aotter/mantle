#!/usr/bin/env node
// Each shipped example runs on top of the app shell, from packed packages: generate, typecheck, then its smoke.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "docs/examples");
const EXAMPLES = ["recipes", "club-events", "purchasing"];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const shell = JSON.parse(readFileSync(join(examples, "app-shell/package.json"), "utf8"));
for (const [name, pinned] of Object.entries(shell.dependencies)) {
  if (name.startsWith("@aotter/mantle") && pinned !== version) throw new Error(`app-shell pins ${name}@${pinned}; bump it to ${version}`);
}
const selected = process.argv.slice(2);
for (const example of selected.length ? selected : EXAMPLES) {
  const source = join(examples, example);
  if (!existsSync(join(source, "manifests"))) throw new Error(`${example}: no manifests/`);
  const steps = ["pnpm generate", "pnpm types", "pnpm check", ...(existsSync(join(source, "smoke.mjs")) ? ["pnpm smoke"] : [])].join(" && ");
  console.log(`check-examples: ${example}`);
  execFileSync(process.execPath, [join(root, "scripts/check-packed-consumer.mjs"), "--project", join(examples, "app-shell"), "--",
    "sh", "-c", `cp -R '${source}'/. . && ${steps}`], { cwd: root, stdio: "inherit", timeout: 900_000 });
}
