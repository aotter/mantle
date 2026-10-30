#!/usr/bin/env node
// Release gate (network): the app `mantle init` writes must install without high or critical npm advisories.
// Packs the SDK packages (the exact candidate, published or not), runs the built workspace `mantle init` into a temp
// directory, points its @aotter/mantle* pins at those tarballs, resolves every other pin from the public registry
// exactly as a fresh install would (npm lockfile, no install scripts) and runs `npm audit --audit-level=high`,
// dev dependencies included: Wrangler is a devDependency and is where the advisories came from (#1777).
// Needs `pnpm build` first. Usage: node scripts/check-init-audit.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/mantle/dist/infrastructure/cli.js");
if (!existsSync(cli)) throw new Error("check-init-audit: run pnpm build first");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packages = JSON.parse(execFileSync("pnpm", ["--filter", "@aotter/mantle*", "list", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }))
  .filter((pkg) => !pkg.private);

const temp = mkdtempSync(join(tmpdir(), "mantle-init-audit-"));
try {
  const artifacts = join(temp, "artifacts");
  mkdirSync(artifacts);
  const tarballs = {};
  for (const { name, path } of packages) {
    execFileSync("pnpm", ["-C", path, "pack", "--pack-destination", artifacts], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    tarballs[name] = `file:${join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)}`;
  }
  const app = join(temp, "app");
  execFileSync(process.execPath, [cli, "init", app], { stdio: ["ignore", "pipe", "inherit"] });
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies)) if (tarballs[name]) manifest.dependencies[name] = tarballs[name];
  // npm: a direct dependency and its override carry the same spec; the override also covers mantle-admin's mantle-ui.
  manifest.overrides = { ...manifest.overrides, ...tarballs };
  writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Public registry only: a user ~/.npmrc may scope @aotter to a private registry.
  const npmrc = join(temp, "npmrc");
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
  const env = { ...process.env, npm_config_userconfig: npmrc, npm_config_registry: "https://registry.npmjs.org/" };
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"], { cwd: app, env, stdio: "inherit" });
  const pins = { ...manifest.dependencies, ...manifest.devDependencies };
  console.log(`check-init-audit: mantle init ${version} app, ${Object.entries(pins).filter(([name]) => !tarballs[name]).map(([name, pin]) => `${name}@${pin}`).join(", ")}`);
  try {
    execFileSync("npm", ["audit", "--audit-level=high"], { cwd: app, env, stdio: "inherit" });
  } catch {
    console.error("check-init-audit: the mantle init app has high or critical advisories. Bump the pins in docs/examples/app-shell/package.json (Wrangler together with a compatible @cloudflare/workers-types), align docs/examples/reference-service, and rerun.");
    process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
