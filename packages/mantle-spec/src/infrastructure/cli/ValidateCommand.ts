import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { exit, stdout, stderr, cwd } from "node:process";
import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";
import { ValidateManifestsUseCase } from "../../usecase/ValidateManifestsUseCase.js";
import { loadManifestsFromRoot } from "./loadManifests.js";

/**
 * `mantle validate` — Loop 1 of the SDK authoring contract
 * (ADR-0007). Walks YAML manifests + handler source, emits
 * structured Diagnostic JSON or pretty text. Exit code 0 on success
 * (no errors; warnings allowed), 1 on any error.
 *
 * Default paths (relative to cwd):
 *   manifests root: ./manifests
 *   handler source: ./src
 *
 * Override with --manifests <dir> / --source <dir>.
 *
 * Output mode:
 *   --format json   → JSON array on stdout (default when piped)
 *   --format text   → pretty-print on stdout (default when TTY)
 *
 * Phase (which gates are active — see Phase doc below):
 *   --phase preview  → grammar checks only; deploy-only gates skipped (default)
 *   --phase deploy   → production/deploy checks
 *
 * Per the clean-architecture rules this is a thin adapter: it loads
 * files, constructs the request DTO, calls the use case, formats the
 * response. No business logic.
 */
export type Phase = "preview" | "deploy";

export interface CliArgs {
  readonly manifests: string;
  readonly source: string | null;
  readonly format: "json" | "text";
  readonly phase: Phase;
}

export function parseArgs(rawArgs: ReadonlyArray<string>): CliArgs {
  let manifests = "./manifests";
  let source: string | null = "./src";
  let format: "json" | "text" | null = null;
  let phase: Phase = "preview";

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--manifests") manifests = rawArgs[++i] ?? manifests;
    else if (a === "--source") source = rawArgs[++i] ?? source;
    else if (a === "--no-source") source = null;
    else if (a === "--format") {
      const v = rawArgs[++i];
      if (v !== "json" && v !== "text") {
        throw new Error(`--format must be 'json' or 'text'; got ${JSON.stringify(v)}`);
      }
      format = v;
    } else if (a === "--json") {
      format = "json";
    } else if (a === "--phase") {
      const v = rawArgs[++i];
      if (v !== "preview" && v !== "deploy") {
        throw new Error(`--phase must be 'preview' or 'deploy'; got ${JSON.stringify(v)}`);
      }
      phase = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else if (a !== undefined) {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (format === null) {
    format = stdout.isTTY ? "text" : "json";
  }

  return { manifests, source, format, phase };
}

function printHelp(): void {
  stdout.write(`mantle validate — Loop 1 static manifest validation

Usage: mantle validate [options]

Options:
  --manifests <dir>   Manifest root (default: ./manifests)
  --source <dir>      Handler source root for register-handler grep
                      (default: ./src)
  --no-source         Skip the handler-source grep entirely
  --phase <phase>     'preview' (default) or 'deploy'.
                        preview: grammar + cross-Schema checks only.
                                 Suitable right after \`create-mantle\`
                                 and during local \`pnpm dev\`.
                        deploy:  adds any pre-deploy-only checks.
                                 Run this before \`wrangler deploy\`.
  --format <fmt>      'json' or 'text' (default: auto by isTTY)
  --json              Alias for --format json
  -h, --help          This help

Exit codes:
  0  no errors (warnings OK)
  1  one or more errors
  2  CLI invocation problem
`);
}

/**
 * Which diagnostic codes are gated to which phase. Codes not listed
 * here fire in every phase. The list is small on purpose — most
 * grammar checks belong in every phase; only lifecycle-stage gates
 * (for example future production secret checks) live here.
 *
 * "deploy" entries mean: the diagnostic is emitted only when phase
 * === "deploy".
 */
const PHASE_GATED_CODES: Readonly<Record<string, Phase>> = {};

function isVisibleInPhase(code: string, phase: Phase): boolean {
  const gate = PHASE_GATED_CODES[code];
  if (gate === undefined) return true;
  return gate === phase;
}

export async function run(rawArgs: ReadonlyArray<string>): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(rawArgs);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const sourceRoot = args.source ? resolve(cwd(), args.source) : null;

  // 1. Load manifests. Loader returns the resolved `root` so we don't
  // re-resolve here and risk drift between the two `cwd()` calls.
  const { manifests, parseErrors, filePaths, root: manifestsRoot } =
    await loadManifestsFromRoot(args.manifests);

  // 2. Concatenate handler source (if any).
  let handlerSource: string | undefined;
  if (sourceRoot) {
    try {
      handlerSource = await loadHandlerSource(sourceRoot);
    } catch (err) {
      stderr.write(`could not read source root ${sourceRoot}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  // 3. Execute the use case.
  const result = ValidateManifestsUseCase.run({ manifests, handlerSource, filePaths });
  const cliWarnings: Diagnostic[] = [];

  // The CLI can't reach the runtime DB to read site_config, so it
  // can't run the SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES check —
  // boot does that. Per ADR-0007's leftward-shift principle, surface
  // a warning so the AI author isn't surprised when boot rejects.
  const hasLocalized = manifests.some(
    (m) => m.kind === "Schema" && m.spec.localized === true,
  );
  if (hasLocalized) {
    cliWarnings.push(
      validateDiagnostic({
        code: "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES",
        severity: "warning",
        path: "cli:locale-check-skipped",
        expected:
          "site_config.locales to declare at least one BCP 47 locale (boot validator will check)",
        message:
          "One or more Schemas declare localized: true. The CLI cannot read site_config; boot will reject if locales are not configured. Verify your CmsConfig.siteDefaults.locales is set.",
      }),
    );
  }

  const rawDiagnostics = [...parseErrors, ...result.diagnostics, ...cliWarnings];

  // Apply phase gating — diagnostics for codes only valid in another
  // phase are dropped before counting.
  const diagnostics = rawDiagnostics.filter((d) => isVisibleInPhase(d.code, args.phase));
  const suppressedCount = rawDiagnostics.length - diagnostics.length;

  let errorCount = 0;
  let warningCount = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errorCount++;
    else warningCount++;
  }

  // 4. Emit.
  if (args.format === "json") {
    stdout.write(
      JSON.stringify(
        { phase: args.phase, diagnostics, errorCount, warningCount, suppressedCount },
        null,
        2,
      ) + "\n",
    );
  } else {
    emitText(diagnostics, errorCount, warningCount, manifestsRoot, args.phase, suppressedCount);
  }

  return errorCount > 0 ? 1 : 0;
}

async function loadHandlerSource(root: string): Promise<string> {
  const exts = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
  const chunks: string[] = [];
  // Probe the root explicitly. walk() swallows readdir errors so it can
  // best-effort skip unreadable SUBdirectories — but that same swallow
  // turns a missing/unreadable source ROOT into an empty string, which
  // then makes every `handler.kind: ref` Procedure emit a spurious
  // HANDLER_NOT_REGISTERED warning instead of a clear "could not read
  // source root" exit-2. Surface the root error here. (#393)
  await readdir(root, { withFileTypes: true });
  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = join(dir, it.name);
      if (it.isDirectory()) {
        if (it.name === "node_modules" || it.name === "dist" || it.name === ".git") continue;
        await walk(full);
      } else if (it.isFile() && exts.some((e) => it.name.endsWith(e))) {
        try {
          chunks.push(await readFile(full, "utf8"));
        } catch {
          // best-effort: skip unreadable files silently
        }
      }
    }
  }
  await walk(root);
  return chunks.join("\n");
}

function emitText(
  diagnostics: ReadonlyArray<Diagnostic>,
  errorCount: number,
  warningCount: number,
  root: string,
  phase: Phase,
  suppressedCount: number,
): void {
  if (diagnostics.length === 0) {
    stdout.write(`OK  no issues (root: ${relative(cwd(), root) || root}, phase: ${phase})\n`);
    if (phase === "preview" && suppressedCount > 0) {
      stdout.write(
        `ℹ ${suppressedCount} deploy-only gate(s) skipped — re-run with \`--phase deploy\` before shipping.\n`,
      );
    }
    return;
  }
  for (const d of diagnostics) {
    const sevTag = d.severity === "error" ? "ERROR" : "warn ";
    stdout.write(`[${sevTag}] ${d.code}\n`);
    stdout.write(`         at ${d.path}\n`);
    if (d.expected) stdout.write(`         expected: ${d.expected}\n`);
    if (d.value !== undefined) stdout.write(`         value:    ${formatValue(d.value)}\n`);
    if (d.suggestion) stdout.write(`         suggest:  ${d.suggestion}\n`);
    if (d.message) stdout.write(`         ${d.message}\n`);
    stdout.write("\n");
  }
  stdout.write(`${errorCount} error(s), ${warningCount} warning(s) (phase: ${phase}).\n`);
  if (phase === "preview" && suppressedCount > 0) {
    stdout.write(
      `ℹ ${suppressedCount} deploy-only gate(s) skipped — re-run with \`--phase deploy\` before shipping.\n`,
    );
  }
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
