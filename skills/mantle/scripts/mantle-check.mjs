#!/usr/bin/env node
// The Mantle plugin's Cloud helper (ADR-0032 decision 13, ADR-0034 decision 3). It compiles the project's manifests with the
// project's own installed @aotter/mantle/spec (the plugin bundles no parser), and reports what Mantle Cloud would verify: the Core
// version, the plan fingerprint and the source hash, and whether .mantle/generated/plan.json is that plan.
//
//   node mantle-cloud.mjs check [--project <dir>] [--manifests <dir>] [--core <version>]
//
// One JSON line on stdout: { ok, coreVersion, fingerprint, sourceHash, planFile, cloud, nextAction? } or { ok: false, error, detail?, nextAction }.
// Exit 0 when ok. It reads only the project, writes nothing and contacts no network.
// Offline readiness only; mantle-cloud.mjs owns the public entry and delegates uploads to Cloud's shared helper.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const out = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exit(line.ok ? 0 : 1);
};
const fail = (error, detail, nextAction) => out({ ok: false, error, ...(detail ? { detail } : {}), nextAction });

let args;
try {
  args = parseArgs({ allowPositionals: true, options: { project: { type: "string" }, manifests: { type: "string" }, core: { type: "string" } } });
} catch (error) {
  fail("usage", String(error.message), { kind: "fix", reason: "node mantle-cloud.mjs check [--project <dir>] [--manifests <dir>] [--core <version>]" });
}
if (args.positionals.join(" ") !== "check") fail("usage", "the only verb is check", { kind: "fix", reason: "node mantle-cloud.mjs check" });

const project = resolve(args.values.project ?? ".");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
if (!existsSync(join(project, "package.json"))) fail("project_missing", project, { kind: "fix", reason: "Run from the application root, or pass --project <dir>." });

// the project's own Core: its version is what Cloud pins against, and its compiler is the only one used
const require = createRequire(join(project, "package.json"));
let corePackage;
try {
  corePackage = require.resolve("@aotter/mantle/package.json");
} catch {
  fail("core_missing", "@aotter/mantle is not installed in the project", { kind: "run", command: "the project's package manager: install @aotter/mantle at an exact version" });
}
const core = readJson(corePackage);
if (!/^0\.2\./.test(core.version)) fail("core_unsupported", `@aotter/mantle ${core.version}`, { kind: "fix", reason: "This helper serves Mantle 0.2. A 0.1.x project upgrades with node_modules/@aotter/mantle/docs/upgrade-0.1-to-0.2.md after installing 0.2." });
if (args.values.core && args.values.core !== core.version) {
  fail("core_mismatch", `installed ${core.version}, Cloud pins ${args.values.core}`, { kind: "fix", reason: `Install @aotter/mantle@${args.values.core} exactly, then rerun mantle generate.` });
}
const spec = await import(pathToFileURL(join(dirname(corePackage), core.exports["./spec"].import)).href);

// the manifests and the source hash exactly as `mantle generate` reads them: files directly in the directory, by name, BOM and CRLF removed
const config = existsSync(join(project, "mantle.config.json")) ? readJson(join(project, "mantle.config.json")) : {};
const manifests = resolve(project, args.values.manifests ?? "manifests");
if (!existsSync(manifests)) fail("manifests_missing", manifests, { kind: "fix", reason: "Pass --manifests <dir>, or create manifests/." });
const files = readdirSync(manifests, { withFileTypes: true })
  .filter((d) => !d.isDirectory() && /\.ya?ml$/i.test(d.name))
  .map((d) => d.name).sort()
  .map((name) => ({ name, text: readFileSync(join(manifests, name), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n") }));
const sourceHash = createHash("sha256").update(JSON.stringify(files.map((f) => [f.name, f.text]))).digest("hex");

if (config.dialect && !["sqlite", "d1", "@aotter/mantle/d1"].includes(config.dialect)) {
  // Mantle Cloud runs D1 plans only (ADR-0035 decision 5)
  fail("dialect_unsupported", config.dialect, { kind: "fix", reason: "Mantle Cloud accepts plans for the built-in D1 dialect only." });
}
const compiled = await spec.compilePlan({ sources: files.map((f) => ({ sourceId: f.name, text: f.text })) });
if (!compiled.ok) {
  fail("plan_invalid", compiled.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.path}: ${d.message}`).join("\n"), { kind: "run", command: "mantle generate", reason: "Fix the manifests it names." });
}

const planPath = join(project, ".mantle/generated/plan.json");
const generated = existsSync(planPath) ? readJson(planPath) : null;
const planFile = !generated ? "missing" : generated.sourceHash === sourceHash && generated.plan?.fingerprint === compiled.plan.fingerprint ? "fresh" : "stale";

out({
  ok: planFile === "fresh",
  coreVersion: core.version,
  fingerprint: compiled.plan.fingerprint,
  sourceHash,
  planFile,
  // Offline validation cannot prove access, provisioning, or a deployed release.
  cloud: "not_checked",
  ...(planFile === "fresh" ? {} : { nextAction: { kind: "run", command: "mantle generate", reason: "Commit .mantle/generated/ after regenerating." } }),
});
