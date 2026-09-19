import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cwd, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ValidateManifestsUseCase, type Diagnostic } from "@aotter/mantle-spec";
import { loadManifestsFromRoot } from "@aotter/mantle-spec/cli";
import { assertMantleNamespace, emitMantleModule } from "../codegen/emitMantleModule.js";

interface GenerateOptions {
  readonly manifests: string;
  readonly output: string;
  readonly namespace: string;
  readonly check: boolean;
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

  const loaded = await loadManifestsFromRoot(options.manifests);
  const validation = loaded.parsed
    ? ValidateManifestsUseCase.run({ parsed: loaded.parsed })
    : { diagnostics: [], errorCount: 0, warningCount: 0 };
  const validationErrors = [...loaded.parseErrors, ...validation.diagnostics]
    .filter((diagnostic) => diagnostic.severity === "error");
  if (validationErrors.length > 0 || !validation.linked) {
    printDiagnostics(validationErrors);
    return 1;
  }

  const emitted = emitMantleModule({
    linked: validation.linked,
    namespace: options.namespace,
  });
  if (!emitted.ok) {
    printDiagnostics(emitted.diagnostics);
    return 1;
  }

  const output = resolve(cwd(), options.output);
  let stale = !(await syncText(join(output, "mantle.ts"), emitted.source, options.check));
  const adminIndex = (deps.resolveAdminUiIndexHtml ?? resolveAdminUiIndexHtml)();
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
  };
}

function printHelp(): void {
  stdout.write(`mantle generate — compile manifests into a typed runtime binding

Usage: mantle generate [options]

This is the Minimal (API-only) compile path. It writes .mantle/generated/mantle.ts.
When @aotter/mantle-admin-ui is installed it also syncs the prebuilt Admin SPA.
See \`mantle --help\` for the Admin / Dev UI layer.

Options:
  --manifests <dir>   Manifest directory (default: ./manifests)
  -o, --output <dir>  Generated root (default: .mantle/generated)
  --namespace <name>  Generated type namespace (default: Mantle)
  --check             Fail without writing when generated code or Admin assets are stale
  -h, --help          This help
`);
}

export function printGenerateNextSteps(adminUiInstalled: boolean, write = stdout.write.bind(stdout)): void {
  if (adminUiInstalled) {
    write(
      "Synced public/_mantle/admin/ from @aotter/mantle-admin-ui (prebuilt; do not vite-build).\n" +
        "Next — local Admin / Dev UI:\n" +
        "  1. wrangler assets.directory=./public and binding=ASSETS\n" +
        "  2. pnpm dev  →  open /admin/sign-in\n" +
        "  3. email OTP via ConsoleEmailSender (code in wrangler logs)\n" +
        "See docs/examples/local-admin-otp.\n",
    );
    return;
  }
  write(
    "API-only. To add Admin / Dev UI: install @aotter/mantle-admin and @aotter/mantle-admin-ui, " +
      "re-run generate, configure wrangler ASSETS, and wire local email-otp " +
      "(docs/examples/local-admin-otp).\n",
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
