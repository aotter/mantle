#!/usr/bin/env node
// Verifies every file vendored into a plugin skill against the VENDORED.json
// beside it. The bundle must stay byte-exact: its SHA-256 is what the source
// repository built, and mantle-host sends it to Mantle Cloud. The bundle's own
// `version --json` must report the protocol and Core pin the record states,
// and that pin must be this repository's Core version: Cloud rejects a script
// packed for another Core.
//
//   node scripts/check-plugin-vendor.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreVersion = JSON.parse(readFileSync(join(repoRoot, "packages/mantle/package.json"), "utf8")).version;
const KEYS = ["source", "path", "commit", "sha256", "protocol", "coreVersion", "builtWith"];
const failures = [];
const checked = [];

const directories = (path) => existsSync(path)
  ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
  : [];

/** Returns the problems with one VENDORED.json record and the file it names. */
function verifyVendored(record, bytes) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["expected an object"];
  const keys = Object.keys(record);
  const extra = keys.filter((key) => !KEYS.includes(key));
  const missing = KEYS.filter((key) => !keys.includes(key));
  if (extra.length) problems.push(`unknown keys: ${extra.join(", ")}`);
  if (missing.length) problems.push(`missing keys: ${missing.join(", ")}`);
  if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(record.source ?? "")) problems.push("source must be <owner>/<repo>");
  if (typeof record.path !== "string" || !record.path) problems.push("path must name the built file");
  if (!/^[0-9a-f]{40}$/.test(record.commit ?? "")) problems.push("commit must be a full 40-hex Git commit");
  if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) problems.push("sha256 must be 64 lowercase hex characters");
  if (!Number.isInteger(record.protocol) || record.protocol < 1) problems.push("protocol must be a positive integer");
  if (typeof record.builtWith !== "string" || !record.builtWith) problems.push("builtWith must name the build command");
  if (record.coreVersion !== coreVersion) {
    problems.push(`coreVersion ${record.coreVersion} is not packages/mantle ${coreVersion}; re-vendor a build pinned to ${coreVersion} (skills/README.md)`);
  }
  if (bytes === null) problems.push(`vendored file ${basename(record.path ?? "")} is missing`);
  else {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.sha256) problems.push(`SHA-256 is ${actual}, VENDORED.json says ${record.sha256}; re-vendor, never edit the file`);
  }
  return problems;
}

/** What the bundle itself reports; run outside the repository so nothing resolves from it. */
function selfReport(file) {
  try {
    const line = execFileSync(process.execPath, [file, "version", "--json"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 })
      .split("\n").find((text) => text.startsWith("{"));
    return JSON.parse(line);
  } catch (error) {
    return { error: String(error.message ?? error).split("\n")[0] };
  }
}

for (const plugin of directories(join(repoRoot, "plugins"))) {
  for (const skill of directories(join(plugin, "skills"))) {
    const scripts = join(skill, "scripts");
    const manifest = join(scripts, "VENDORED.json");
    const where = relative(repoRoot, manifest);
    if (!existsSync(manifest)) {
      // A plugin skill carries no scripts of its own; anything there is vendored.
      if (existsSync(scripts) && readdirSync(scripts).length > 0) failures.push(`${relative(repoRoot, scripts)}: files without a VENDORED.json`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (error) {
      failures.push(`${where}: invalid JSON (${error.message})`);
      continue;
    }
    // The vendored file keeps its built name and sits beside the record.
    const name = basename(String(record?.path ?? ""));
    const file = join(scripts, name);
    const bytes = record?.path && existsSync(file) ? readFileSync(file) : null;
    const problems = verifyVendored(record, bytes);
    const unvendored = readdirSync(scripts).filter((entry) => entry !== "VENDORED.json" && entry !== name);
    if (unvendored.length) problems.push(`files not named by VENDORED.json: ${unvendored.join(", ")}`);
    if (problems.length === 0) {
      const report = selfReport(file);
      if (report.error) problems.push(`${name} version --json failed: ${report.error}`);
      else {
        if (report.protocol !== record.protocol) problems.push(`protocol ${record.protocol} is not the bundle's hostProtocol.current ${report.protocol}`);
        if (report.core?.version !== record.coreVersion) problems.push(`coreVersion ${record.coreVersion} is not the bundle's Core pin ${report.core?.version}`);
      }
    }
    for (const problem of problems) failures.push(`${where}: ${problem}`);
    checked.push(`${relative(repoRoot, file)} @ ${String(record?.commit).slice(0, 12)}, protocol ${record?.protocol}, Core ${record?.coreVersion}`);
  }
}

if (checked.length === 0) failures.push("plugins/: no VENDORED.json found");
if (failures.length > 0) {
  console.error(`check-plugin-vendor: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-plugin-vendor: ${checked.length} vendored file(s) match (${checked.join("; ")})`);
