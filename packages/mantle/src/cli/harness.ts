#!/usr/bin/env node
import { argv, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import {
  ValidateManifestsUseCase,
  type Diagnostic,
} from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { loadManifestsFromRoot } from "@aotter/mantle-spec/cli";
import {
  benchmarkHttpRoutes,
  inspectIndexCoverage,
  type HttpBenchmarkReport,
  type IndexCoverageReport,
} from "@aotter/mantle-runtime/testing";

type Format = "json" | "text";

async function main(): Promise<number> {
  const command = argv[2];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return command ? 0 : 2;
  }
  if (command === "indexes") return runIndexes(argv.slice(3));
  if (command === "http") return runHttp(argv.slice(3));
  stderr.write(`Unknown subcommand: ${command}\n`);
  return 2;
}

async function runIndexes(rawArgs: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...rawArgs],
      options: {
        manifests: { type: "string" },
        rows: { type: "string" },
        require: { type: "string", multiple: true },
        "require-public": { type: "boolean" },
        format: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }
  if (values.help) {
    printIndexesHelp();
    return 0;
  }
  const format = outputFormat(values.format);
  const loaded = await loadManifestsFromRoot(values.manifests ?? "./manifests");
  const validation = loaded.parsed
    ? ValidateManifestsUseCase.run({ parsed: loaded.parsed })
    : { diagnostics: [], errorCount: 0, warningCount: 0 };
  const errors = [...loaded.parseErrors, ...validation.diagnostics]
    .filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    emitErrors(errors, format);
    return 1;
  }
  if (!validation.linked || validation.linked.schemas.length === 0) {
    stderr.write(`No manifests found under ${values.manifests ?? "./manifests"}\n`);
    return 2;
  }
  const compiled = compileRuntimePlan(validation.linked);
  if (!compiled.ok) {
    emitErrors(compiled.diagnostics, format);
    return 1;
  }
  const rows = values.rows === undefined ? undefined : Number(values.rows);
  if (rows !== undefined && (!Number.isFinite(rows) || rows <= 0)) {
    stderr.write("--rows must be a positive number\n");
    return 2;
  }
  const report = await inspectIndexCoverage(compiled.value, {
    rowsPerSchema: rows,
    requirePublic: values["require-public"] === true,
    requiredViews: values.require ?? [],
  });
  emitIndexReport(report, format);
  return report.summary.requiredFailures > 0 ? 1 : 0;
}

async function runHttp(rawArgs: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...rawArgs],
      options: {
        route: { type: "string", multiple: true },
        "base-url": { type: "string" },
        rounds: { type: "string" },
        warmup: { type: "string" },
        format: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }
  if (values.help) {
    printHttpHelp();
    return 0;
  }
  if (!values.route || values.route.length === 0) {
    stderr.write("http requires at least one --route name=/path-or-url\n");
    return 2;
  }
  const format = outputFormat(values.format);
  const baseUrl = (values["base-url"] ?? "").replace(/\/$/, "");
  const targets = values.route.map((raw) => {
    const separator = raw.indexOf("=");
    if (separator < 1) throw new Error(`invalid --route ${JSON.stringify(raw)}`);
    const name = raw.slice(0, separator);
    const path = raw.slice(separator + 1);
    return { name, url: path.startsWith("/") ? `${baseUrl}${path}` : path };
  });
  if (targets.some(({ url }) => !/^https?:\/\//.test(url))) {
    stderr.write("route URLs must be absolute, or use --base-url with /paths\n");
    return 2;
  }
  let report: HttpBenchmarkReport;
  try {
    report = await benchmarkHttpRoutes({
      targets,
      rounds: numericOption(values.rounds, "--rounds"),
      warmup: numericOption(values.warmup, "--warmup"),
    });
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 1;
  }
  emitHttpReport(report, format);
  return 0;
}

function emitIndexReport(report: IndexCoverageReport, format: Format): void {
  if (format === "json") {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const path of report.paths) {
    const status = path.required ? path.passed ? "PASS" : "FAIL" : "ADVISORY";
    const detail = path.findings.length > 0
      ? path.findings.join("; ")
      : path.usedIndexes.join(", ") || "planner found no named index";
    stdout.write(`${status} ${path.view}: ${detail}\n`);
  }
  for (const view of report.summary.missingRequiredViews) {
    stdout.write(`FAIL ${view}: required View not found\n`);
  }
  stdout.write(
    `views=${report.summary.views} required=${report.summary.required} ` +
      `failures=${report.summary.requiredFailures} rows/schema=${report.rowsPerSchema}\n`,
  );
}

function emitHttpReport(report: HttpBenchmarkReport, format: Format): void {
  if (format === "json") {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const result of report.results) {
    const queries = result.queryCount ? ` queries.p95=${result.queryCount.p95}` : "";
    const rows = result.rowsRead ? ` rows_read.p95=${result.rowsRead.p95}` : "";
    stdout.write(
      `${result.name}: p50=${result.timingMs.p50.toFixed(2)}ms ` +
        `p95=${result.timingMs.p95.toFixed(2)}ms${queries}${rows}\n`,
    );
  }
}

function emitErrors(errors: readonly Diagnostic[], format: Format): void {
  if (format === "json") stdout.write(`${JSON.stringify({ errors }, null, 2)}\n`);
  else for (const error of errors) stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
}

function outputFormat(raw: string | undefined): Format {
  if (raw === undefined) return stdout.isTTY ? "text" : "json";
  if (raw === "json" || raw === "text") return raw;
  throw new Error(`--format must be text or json; got ${JSON.stringify(raw)}`);
}

function numericOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  stdout.write(`mantle-harness — measured performance checks\n\n` +
    `Usage: mantle-harness <indexes|http> [options]\n\n` +
    `  indexes  Execute compiled Views in crowded SQLite and inspect plans\n` +
    `  http     Sample a running Worker and report p50/p95 + metric headers\n`);
}

function printIndexesHelp(): void {
  stdout.write(`Usage: mantle-harness indexes [options]\n\n` +
    `  --manifests <dir>  Directory containing YAML manifests (default: ./manifests)\n` +
    `  --rows <n>         Deterministic rows per Schema (default: 2000)\n` +
    `  --require <view>   Fail when this View lacks its access path; repeatable\n` +
    `  --require-public   Apply the gate to public Views\n` +
    `  --format <fmt>     text or json\n`);
}

function printHttpHelp(): void {
  stdout.write(`Usage: mantle-harness http [options]\n\n` +
    `  --base-url <url>   Prefix for route paths\n` +
    `  --route <name=url> Route label and path/URL; repeatable\n` +
    `  --rounds <n>       Measured requests per route (default: 20)\n` +
    `  --warmup <n>       Warmup requests per route (default: 2)\n` +
    `  --format <fmt>     text or json\n`);
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    stderr.write(`${message(error)}\n`);
    process.exitCode = 2;
  },
);
