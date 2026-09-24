import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { cwd, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseManifestSources, ValidateManifestsUseCase, type Diagnostic } from "@aotter/mantle-spec";
import { loadManifestsFromRoot } from "@aotter/mantle-spec/cli";
import { assertMantleNamespace, emitMantleModule } from "../codegen/emitMantleModule.js";
import { prepareProject } from "./generate-project.js";
import { prepareSites } from "./generate-sites.js";

interface GenerateOptions {
  readonly manifests: string;
  readonly output: string;
  readonly namespace: string;
  readonly check: boolean;
  readonly host?: string;
  readonly features?: string;
  readonly adopt: boolean;
  readonly manifestsExplicit: boolean;
  readonly reviewUniqueIndexes: boolean;
}

/** Test seam for Core-only vs Admin-present installs. */
export interface GenerateDeps {
  readonly resolveAdminUiIndexHtml?: () => string | null;
}

/**
 * Locate the optional Admin SPA. A Core-only install does not have
 * `@aotter/mantle-admin-ui`, so resolution failure is not an error.
 */
export function resolveAdminUiIndexHtml(): string | null {
  try {
    const path = fileURLToPath(import.meta.resolve("@aotter/mantle-admin-ui/index.html"));
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function resolveProjectAdminUiIndexHtml(root: string): string | null {
  try {
    const path = createRequire(join(root, "package.json")).resolve("@aotter/mantle-admin-ui/index.html");
    return existsSync(path) ? path : null;
  } catch { return null; }
}

export async function runGenerate(
  rawArgs: readonly string[],
  deps: GenerateDeps = {},
): Promise<number> {
  let options: GenerateOptions;
  try {
    const parsed = parseGenerateArgs(rawArgs);
    if (parsed === null) {
      printHelp();
      return 0;
    }
    options = parsed;
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }

  const root = cwd();
  let loaded = await loadManifestsFromRoot(options.manifests);
  if (loaded.parseErrors.some((diagnostic) => diagnostic.code !== "MANIFEST_ROOT_NOT_FOUND") ||
      (options.manifestsExplicit && loaded.parseErrors.length > 0)) {
    printDiagnostics(loaded.parseErrors);
    return 1;
  }
  let project;
  try {
    project = await prepareProject({
      root, host: options.host, features: options.features, adopt: options.adopt, check: options.check, output: options.output,
      adminAssetsCurrent: async () => {
        const index = (deps.resolveAdminUiIndexHtml ?? (() => resolveProjectAdminUiIndexHtml(root)))();
        return index !== null && syncAdminAssets(dirname(index), resolve(root, "public/_mantle/admin"), true);
      },
    });
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }
  if (project.mode === "project" && !options.manifestsExplicit && loaded.parseErrors.length === 1 &&
      loaded.parseErrors[0]?.code === "MANIFEST_ROOT_NOT_FOUND") {
    let names: string[];
    try { names = await readdir(resolve(root, options.manifests)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        printDiagnostics(loaded.parseErrors);
        return 1;
      }
      names = [];
    }
    if (!names.some((name) => /\.ya?ml$/i.test(name))) {
      const empty = parseManifestSources({ sources: [] });
      if (empty.ok) loaded = { parsed: empty.value, parseErrors: [], root: loaded.root };
    }
  }
  const validation = loaded.parsed
    ? ValidateManifestsUseCase.run({ parsed: loaded.parsed })
    : { diagnostics: [], errorCount: 0, warningCount: 0 };
  const validationErrors = [...loaded.parseErrors, ...validation.diagnostics]
    .filter((diagnostic) => diagnostic.severity === "error");
  if (validationErrors.length > 0 || !validation.linked) {
    printDiagnostics(validationErrors);
    return 1;
  }
  if (project.mode === "project" && project.selection?.host !== "cf") {
    const schedule = loaded.parsed!.entries.find((entry) =>
      entry.manifest.kind === "Trigger" && entry.manifest.spec.source.kind === "schedule");
    if (schedule) {
      stderr.write(`RESOURCE_UNAVAILABLE: Trigger '${schedule.manifest.metadata.name}' requires host 'cf'; '${project.selection?.host ?? "none"}' does not register Cron Triggers.\n`);
      return 1;
    }
  }

  const emitted = emitMantleModule({
    linked: validation.linked,
    namespace: options.namespace,
  });
  if (!emitted.ok) {
    printDiagnostics(emitted.diagnostics);
    return 1;
  }

  let sites: Awaited<ReturnType<typeof prepareSites>> | null = null;
  if (options.reviewUniqueIndexes && project.selection?.host !== "chatgpt-sites") {
    stderr.write("--review-unique-indexes requires a managed ChatGPT Sites project.\n");
    return 2;
  }
  if (project.mode === "project" && project.selection?.host === "chatgpt-sites") {
    try {
      sites = await prepareSites(root, project.selection.output ?? options.output, project.selection,
        loaded.parsed!.entries.filter((entry) => entry.manifest.kind === "Schema").map((entry) => entry.manifest as import("@aotter/mantle-spec").SchemaManifest), options.check,
        options.reviewUniqueIndexes);
      if (sites.report) stdout.write(`${sites.report}\n`);
    } catch (error) {
      stderr.write(`${message(error)}\n`);
      return 2;
    }
  }

  const adminIndex = project.mode === "legacy" || project.selection?.features.includes("admin")
    ? (deps.resolveAdminUiIndexHtml ?? (project.mode === "legacy" ? resolveAdminUiIndexHtml : () => resolveProjectAdminUiIndexHtml(root)))()
    : null;
  const adminUnavailable = project.selection?.features.includes("admin") && adminIndex === null;
  if (adminUnavailable) {
    stderr.write("Selected Admin UI is not installed or its assets are missing. Install declared packages and rerun mantle generate.\n");
    if (!options.check && !project.incomplete) return 1;
  }
  if (!options.check && project.commit) {
    try { await project.commit(); await sites?.commit(); }
    catch (error) { stderr.write(`${message(error)}\n`); return 2; }
  }
  if (project.incomplete && !options.check) return 1;
  const output = resolve(cwd(), project.selection?.output ?? options.output);
  const generatedCurrent = await syncText(join(output, "mantle.ts"), emitted.source, options.check);
  let stale = project.incomplete || adminUnavailable || !generatedCurrent || Boolean(sites?.stale);
  if (adminIndex !== null) {
    const adminSource = dirname(adminIndex);
    const adminTarget = resolve(cwd(), "public/_mantle/admin");
    stale = !(await syncAdminAssets(adminSource, adminTarget, options.check)) || stale;
    if (!options.check) warnMissingWranglerAssets(cwd());
  }
  if (stale && options.check) {
    stderr.write("Mantle generated files are stale; run `mantle generate`.\n");
    return 1;
  }
  if (project.mode === "project") {
    if (!options.check) stdout.write(project.selection?.host === "cf"
      ? "Generated Cloudflare Worker composition and typed bindings.\n"
      : project.selection?.host === "chatgpt-sites"
        ? "Generated ChatGPT Sites composition and typed bindings. Apply reviewed local D1 migrations before serving.\n"
        : "Generated host-free Spec bindings.\n");
    return 0;
  }
  if (!options.check) printGenerateNextSteps(adminIndex !== null);
  return 0;
}

function parseGenerateArgs(rawArgs: readonly string[]): GenerateOptions | null {
  const { values } = parseArgs({
    args: [...rawArgs],
    options: {
      manifests: { type: "string" },
      output: { type: "string", short: "o" },
      namespace: { type: "string" },
      host: { type: "string" },
      features: { type: "string" },
      adopt: { type: "boolean" },
      "review-unique-indexes": { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return null;
  const namespace = values.namespace ?? "Mantle";
  assertMantleNamespace(namespace, "--namespace");
  return {
    manifests: values.manifests ?? "./manifests",
    output: values.output ?? ".mantle/generated",
    namespace,
    check: values.check === true,
    host: values.host,
    features: values.features,
    adopt: values.adopt === true,
    reviewUniqueIndexes: values["review-unique-indexes"] === true,
    manifestsExplicit: values.manifests !== undefined,
  };
}

function printHelp(): void {
  stdout.write(`mantle generate — compile manifests and assemble selected application features

Usage: mantle generate [options]

For a new application, the default selects Spec, Runtime, API, MCP, Admin and Web.
Select a host with --host cf or --host chatgpt-sites. --features replaces the
default with a positive list; required feature dependencies are added.
Existing authored applications retain compile-only mode until --adopt.

Options:
  --manifests <dir>   Manifest directory (default: ./manifests)
  -o, --output <dir>  Generated root (default: .mantle/generated)
  --namespace <name>  Generated type namespace (default: Mantle)
  --host <name>       cf or chatgpt-sites (required for host-dependent features)
  --features <list>   Comma-separated: spec,runtime,api,mcp,admin,web
  --adopt             Adopt an existing authored application into saved selection
  --review-unique-indexes  Plan a reviewed Sites unique-index tuple replacement
  --check             Check selection, dependencies and output without writing
  -h, --help          This help

Documentation:
  Handbook: docs/handbook/start/project-and-cli.md or https://mantle.tools/
`);
}

export function printGenerateNextSteps(adminUiInstalled: boolean, write = stdout.write.bind(stdout)): void {
  if (adminUiInstalled) {
    write(
      "Synced public/_mantle/admin/ from @aotter/mantle-admin-ui (opt-in, prebuilt; do not vite-build).\n" +
        "Admin / Dev UI next steps:\n" +
        "  1. wrangler assets.directory=./public and binding=ASSETS\n" +
        "  2. pnpm dev  →  open /admin/sign-in\n" +
        "  3. email OTP via ConsoleEmailSender (code in wrangler logs)\n" +
        "PUBLIC_ORIGIN must equal the origin wrangler prints; a mismatch is INVALID_ORIGIN.\n" +
        "See docs/examples/host-local-admin-otp or node_modules/@aotter/mantle/docs/examples/host-local-admin-otp.\n",
    );
    return;
  }
  write(
    "API-only (Admin is opt-in). A complete service does not require a Dev UI. " +
      "To add Admin later: install @aotter/mantle-admin and @aotter/mantle-admin-ui, " +
      "re-run generate, configure wrangler ASSETS, and wire local email-otp " +
      "(docs/examples/host-local-admin-otp or node_modules/@aotter/mantle/docs/examples/host-local-admin-otp).\n",
  );
}

function printDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    stderr.write(`${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}\n`);
  }
}

async function syncText(path: string, expected: string, check: boolean): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === expected) return true;
  if (check) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected, "utf8");
  return true;
}

/** Cheap hint: Admin SPA was synced but wrangler has no ASSETS binding. */
export function warnMissingWranglerAssets(root: string, write = stderr.write.bind(stderr)): void {
  const wrangler = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]
    .map((name) => join(root, name))
    .find((path) => existsSync(path));
  if (!wrangler) return;
  const text = readFileSync(wrangler, "utf8");
  if (/["']?binding["']?\s*[:=]\s*["']ASSETS["']/.test(text)) return;
  write(
    "warning: @aotter/mantle-admin-ui synced public/_mantle/admin, but wrangler has no ASSETS binding. " +
      "/admin can return HTML 200 while /_mantle/admin/assets/* 404s (white screen). " +
      'Add "assets": { "directory": "./public", "binding": "ASSETS" }. ' +
      "Do not put /_mantle in run_worker_first.\n",
  );
}

async function syncAdminAssets(source: string, target: string, check: boolean): Promise<boolean> {
  const sourceFiles = (await listFiles(source)).filter((path) => !path.startsWith("server."));
  const targetFiles = await listFiles(target).catch(() => []);
  const current = sourceFiles.length === targetFiles.length
    && sourceFiles.every((path, index) => path === targetFiles[index])
    && (await Promise.all(sourceFiles.map(async (path) =>
      (await readFile(join(source, path))).equals(await readFile(join(target, path))),
    ))).every(Boolean);
  if (current || check) return current;

  await rm(target, { recursive: true, force: true });
  for (const path of sourceFiles) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(source, path)));
  }
  return true;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [path];
  }));
  return files.flat().sort();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
