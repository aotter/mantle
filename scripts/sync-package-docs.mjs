#!/usr/bin/env node
// Invoked by packages/mantle pre/postpack with cwd = the package dir. Ships the handbook (`mantle help` reads it), the examples and the plugin skill.
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = process.cwd();
if (packageRoot !== resolve(repoRoot, "packages/mantle")) throw new Error("sync-package-docs must run from packages/mantle");
const target = resolve(packageRoot, "docs");
const SHIPPED = ["handbook", "examples/README.md", "examples/generated-web", "examples/app-shell", "examples/recipes", "examples/club-events", "examples/purchasing", "examples/frontend-mcp-app"];
// Runnable docs may have been installed or run locally; never publish that state.
const LOCAL = ["node_modules", ".wrangler", ".dev.vars", "pnpm-lock.yaml", "generated", "dist"];

rmSync(target, { recursive: true, force: true });
rmSync(resolve(packageRoot,"skills"), {recursive:true,force:true});
if (!process.argv.includes("--clean")) {
  for (const path of SHIPPED) {
    cpSync(resolve(repoRoot, "docs", path), resolve(target, path), { recursive: true, filter: (p) => !LOCAL.includes(basename(p)) });
  }
  cpSync(resolve(repoRoot,"skills"),resolve(packageRoot,"skills"),{recursive:true,filter:p=>!LOCAL.includes(basename(p))});
  // npm pack always drops .gitignore; ship the shell's as `gitignore`, and `mantle init` writes it back as .gitignore.
  cpSync(resolve(repoRoot,"docs/examples/app-shell/.gitignore"),resolve(target,"examples/app-shell/gitignore"));
  const sources = ["scripts/postgres-adapter.ts"];
  for (const source of sources) {
    const destination = resolve(target,"source",source);
    mkdirSync(dirname(destination),{recursive:true});
    writeFileSync(destination,readFileSync(resolve(packageRoot,source),"utf8"));
  }
  const adapter = resolve(target,"handbook/guides/postgres-adapters.md");
  writeFileSync(adapter,readFileSync(adapter,"utf8").replace("../../../packages/mantle/scripts/postgres-adapter.ts","../../source/scripts/postgres-adapter.ts"));
}
