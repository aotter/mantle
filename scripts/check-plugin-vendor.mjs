#!/usr/bin/env node
// Verifies every file vendored into a plugin skill against the VENDORED.json
// beside it. The bundle must stay byte-exact: its SHA-256 is what the source
// repository built, and mantle-host sends it to Mantle Cloud.
//
//   node scripts/check-plugin-vendor.mjs
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["source", "path", "commit", "sha256", "protocol", "builtWith"];
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
  if (bytes === null) problems.push(`vendored file ${basename(record.path ?? "")} is missing`);
  else {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.sha256) problems.push(`SHA-256 is ${actual}, VENDORED.json says ${record.sha256}; re-vendor, never edit the file`);
  }
  return problems;
}

for (const plugin of directories(join(repoRoot, "plugins"))) {
  for (const skill of directories(join(plugin, "skills"))) {
    const manifest = join(skill, "scripts", "VENDORED.json");
    if (!existsSync(manifest)) continue;
    const where = relative(repoRoot, manifest);
    let record;
    try {
      record = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (error) {
      failures.push(`${where}: invalid JSON (${error.message})`);
      continue;
    }
    // The vendored file keeps its built name and sits beside the record.
    const file = join(dirname(manifest), basename(String(record?.path ?? "")));
    const bytes = record?.path && existsSync(file) ? readFileSync(file) : null;
    for (const problem of verifyVendored(record, bytes)) failures.push(`${where}: ${problem}`);
    checked.push(`${relative(repoRoot, file)} @ ${String(record?.commit).slice(0, 12)}`);
  }
}

if (checked.length === 0) failures.push("plugins/: no VENDORED.json found");
if (failures.length > 0) {
  console.error(`check-plugin-vendor: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-plugin-vendor: ${checked.length} vendored file(s) match (${checked.join(", ")})`);
