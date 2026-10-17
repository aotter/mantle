#!/usr/bin/env node
// Invoked by packages/mantle pre/postpack with cwd = the package dir. Ships the docs that describe 0.2.0: the upgrade guide, the
// handbook, the generated website example and the package skills. The other top-level docs/*.md are contributor notes from 0.1.x and stay out.
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = process.cwd();
if (packageRoot !== resolve(repoRoot, "packages/mantle")) throw new Error("sync-package-docs must run from packages/mantle");
const target = resolve(packageRoot, "docs");
const SHIPPED = ["upgrade-0.1-to-0.2.md", "handbook", "examples/README.md", "examples/generated-web", "examples/app-shell", "examples/recipes", "examples/club-events", "examples/purchasing", "skills"];
// Runnable docs may have been installed or run locally; never publish that state.
const LOCAL = ["node_modules", ".wrangler", ".dev.vars", "pnpm-lock.yaml", "generated", "dist"];

rmSync(target, { recursive: true, force: true });
rmSync(resolve(packageRoot,"skills"), {recursive:true,force:true});
if (!process.argv.includes("--clean")) {
  for (const path of SHIPPED) {
    cpSync(resolve(repoRoot, "docs", path), resolve(target, path), { recursive: true, filter: (p) => !LOCAL.includes(basename(p)) });
  }
  cpSync(resolve(repoRoot,"skills"),resolve(packageRoot,"skills"),{recursive:true,filter:p=>!LOCAL.includes(basename(p))});
  const sources = ["scripts/postgres-adapter.ts"];
  for (const source of sources) {
    const destination = resolve(target,"source",source);
    mkdirSync(dirname(destination),{recursive:true});
    writeFileSync(destination,readFileSync(resolve(packageRoot,source),"utf8"));
  }
  const auth = resolve(target,"handbook/cloudflare/authentication.md");
  writeFileSync(auth,readFileSync(auth,"utf8").replace("../../../packages/mantle/README.md","../../../README.md"));
  const adapter = resolve(target,"handbook/guides/postgres-adapters.md");
  writeFileSync(adapter,readFileSync(adapter,"utf8").replace("../../../packages/mantle/scripts/postgres-adapter.ts","../../source/scripts/postgres-adapter.ts"));
}
