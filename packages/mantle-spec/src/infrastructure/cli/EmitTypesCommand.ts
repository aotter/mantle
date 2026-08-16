import { writeFile } from "node:fs/promises";
import { stdout, stderr } from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { EmitTypesUseCase } from "../../usecase/EmitTypesUseCase.js";
import { ValidateManifestsUseCase } from "../../usecase/ValidateManifestsUseCase.js";
import { loadManifestsFromRoot } from "./loadManifests.js";
import { translateParseArgsError } from "./parseArgsError.js";

export interface EmitTypesArgs {
  readonly manifests: string;
  readonly namespace: string;
  readonly output?: string;
}

export type ParseResult = { kind: "args"; args: EmitTypesArgs } | { kind: "help" };

export function parseArgs(rawArgs: ReadonlyArray<string>): ParseResult {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: [...rawArgs],
      options: {
        manifests: { type: "string" },
        namespace: { type: "string" },
        output: { type: "string", short: "o" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    throw translateParseArgsError(err, { "--output": "--output requires a file path" });
  }
  if (values.help) return { kind: "help" };
  return {
    kind: "args",
    args: {
      manifests: values.manifests ?? "./manifests",
      namespace: values.namespace ?? "Mantle",
      output: values.output,
    },
  };
}

function printHelp(): void {
  stdout.write(`mantle emit-types — emit TypeScript .d.ts from manifests

Usage: mantle emit-types [options]

Options:
  --manifests <dir>   Directory containing site.yaml (default: ./manifests)
  --namespace <name>  Top-level namespace (default: Mantle)
  -o, --output <file> Write UTF-8 declarations to a file. Prefer this
                      over shell redirection on Windows.
  -h, --help          This help

Output: TypeScript declarations on stdout unless --output is set.
One namespace contains:
  - Schemas:    interface Entry_<name> { /* data fields */ }
  - Procedures: interface ProcInput_<name> / ProcOutput_<name>
  - Views:      type ViewParams_<name> / ViewRow_<name>
`);
}

export async function run(rawArgs: ReadonlyArray<string>): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(rawArgs);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (parsed.kind === "help") {
    printHelp();
    return 0;
  }
  const args = parsed.args;
  const { parsed: manifestSet, parseErrors } = await loadManifestsFromRoot(args.manifests);
  if (!manifestSet || parseErrors.some((d) => d.severity === "error")) {
    stderr.write(`Manifest parse errors — run \`mantle validate\` to inspect.\n`);
    return 1;
  }
  const validation = ValidateManifestsUseCase.run({ parsed: manifestSet });
  if (validation.errorCount > 0 || !validation.linked) {
    stderr.write(`Manifest validation errors — run \`mantle validate\` to inspect.\n`);
    return 1;
  }
  const { source } = EmitTypesUseCase.run({ linked: validation.linked, namespace: args.namespace });
  if (args.output) {
    await writeFile(args.output, source, "utf8");
  } else {
    stdout.write(source);
  }
  return 0;
}
