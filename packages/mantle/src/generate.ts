import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import { ValidateManifestsUseCase, type Diagnostic } from "@aotter/mantle-spec";
import { loadManifestsFromRoot } from "@aotter/mantle-spec/cli";
import { assertMantleNamespace, emitMantleModule } from "./emitMantleModule.js";

interface GenerateOptions {
  readonly manifests: string;
  readonly output: string;
  readonly namespace: string;
  readonly check: boolean;
}

export async function runGenerate(rawArgs: readonly string[]): Promise<number> {
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
  for (const path of [join(output, "site.ts"), join(output, "types.d.ts")]) {
    if (await readFile(path).then(() => true).catch(() => false)) {
      if (options.check) stale = true;
      else await unlink(path);
    }
  }
  if (stale && options.check) {
    stderr.write("Mantle generated files are stale; run `mantle generate`.\n");
    return 1;
  }
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

Options:
  --manifests <dir>   Manifest directory (default: ./manifests)
  -o, --output <dir>  Generated root (default: .mantle/generated)
  --namespace <name>  Generated type namespace (default: Mantle)
  --check             Fail without writing when generated code is stale
  -h, --help          This help
`);
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
