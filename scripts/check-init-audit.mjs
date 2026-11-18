#!/usr/bin/env node
// Release gate (network): audit the app `mantle init` writes for high and critical npm advisories.
// Packs the SDK packages (the exact candidate, published or not), runs the built workspace `mantle init` into a temp
// directory, points its @aotter/mantle* pins at those tarballs, resolves every other pin from the public registry
// exactly as a fresh install would (npm lockfile, no install scripts) and runs `npm audit --audit-level=high`,
// dev dependencies included: Wrangler is a devDependency and is where the advisories came from (#1777).
// Needs `pnpm build` first. Usage: node scripts/check-init-audit.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Alpha.6 only: Snyk revoked this advisory and Vite considers it a false positive.
// The scaffold's Admin/MCP build takes glob rules from build inputs, not service requests.
// https://github.com/vitejs/vite/issues/24131#issuecomment-6963223033
const alpha6Advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

function onlyAlpha6Advisory(report) {
  if (report?.auditReportVersion !== 2 || report.error || !report.vulnerabilities) return false;
  const entries = Object.values(report.vulnerabilities);
  const high = entries.filter(entry => entry.severity === "high");
  if (
    high.length === 0 ||
    high.length !== report.metadata?.vulnerabilities?.high ||
    report.metadata.vulnerabilities.critical !== 0 ||
    entries.some(entry => entry.severity === "critical")
  )
    return false;

  // npm lists inherited advisories as package names in via. Follow only the reported
  // High entries, and require every High to lead to the one approved advisory.
  const explained = new Set();
  for (const { name, via } of high) {
    if (report.vulnerabilities[name]?.via !== via || !Array.isArray(via) || via.length === 0) return false;
    for (const advisory of via) {
      if (typeof advisory === "string") {
        if (!Object.hasOwn(report.vulnerabilities, advisory)) return false;
      } else {
        if (
          advisory?.severity === "high" &&
          name === "picomatch" &&
          advisory.name === name &&
          advisory.url === alpha6Advisory
        )
          explained.add(name);
        else if (!["info", "low", "moderate"].includes(advisory?.severity)) return false;
      }
    }
  }
  let previousSize;
  do {
    previousSize = explained.size;
    for (const { name, via } of high) {
      if (via.some(parent => explained.has(parent))) explained.add(name);
    }
  } while (explained.size > previousSize);
  return explained.size === high.length;
}

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/mantle/dist/infrastructure/cli.js");
if (!existsSync(cli)) throw new Error("check-init-audit: run pnpm build first");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packages = JSON.parse(
  execFileSync("pnpm", ["--filter", "@aotter/mantle*", "list", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
  }),
).filter(pkg => !pkg.private);

const temp = mkdtempSync(join(tmpdir(), "mantle-init-audit-"));
try {
  const artifacts = join(temp, "artifacts");
  mkdirSync(artifacts);
  const tarballs = {};
  for (const { name, path } of packages) {
    execFileSync("pnpm", ["-C", path, "pack", "--pack-destination", artifacts], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    tarballs[name] = `file:${join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)}`;
  }
  const app = join(temp, "app");
  execFileSync(process.execPath, [cli, "init", app], { stdio: ["ignore", "pipe", "inherit"] });
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies))
    if (tarballs[name]) manifest.dependencies[name] = tarballs[name];
  // npm: a direct dependency and its override carry the same spec; the override also covers mantle-admin's mantle-ui.
  manifest.overrides = { ...manifest.overrides, ...tarballs };
  writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Public registry only: a user ~/.npmrc may scope @aotter to a private registry.
  const npmrc = join(temp, "npmrc");
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
  const env = { ...process.env, npm_config_userconfig: npmrc, npm_config_registry: "https://registry.npmjs.org/" };
  execFileSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"],
    { cwd: app, env, stdio: "inherit" },
  );
  const pins = { ...manifest.dependencies, ...manifest.devDependencies };
  console.log(
    `check-init-audit: mantle init ${version} app, ${Object.entries(pins)
      .filter(([name]) => !tarballs[name])
      .map(([name, pin]) => `${name}@${pin}`)
      .join(", ")}`,
  );
  const temporaryException = version === "0.2.2-alpha.6";
  const audit = spawnSync("npm", ["audit", "--audit-level=high", ...(temporaryException ? ["--json"] : [])], {
    cwd: app,
    env,
    encoding: "utf8",
    stdio: ["ignore", temporaryException ? "pipe" : "inherit", "inherit"],
  });
  if (audit.stdout) process.stdout.write(audit.stdout);
  if (audit.error) throw audit.error;
  if (temporaryException && audit.status === 1 && onlyAlpha6Advisory(JSON.parse(audit.stdout))) {
    console.warn(`check:init-audit: alpha.6 temporary exception applied to ${alpha6Advisory}`);
  } else if (audit.status !== 0) {
    console.error(
      "check-init-audit: the mantle init app has high or critical advisories. Bump the pins in docs/examples/app-shell/package.json (Wrangler together with a compatible @cloudflare/workers-types), align docs/examples/reference-service, and rerun.",
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
