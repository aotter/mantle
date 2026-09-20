import { stdout, stderr } from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { IntrospectManifestsUseCase } from "../../usecase/IntrospectManifestsUseCase.js";
import { loadManifestsFromRoot } from "./loadManifests.js";
import { translateParseArgsError } from "./parseArgsError.js";

export interface IntrospectArgs {
  readonly manifests: string;
}

export type ParseResult = { kind: "args"; args: IntrospectArgs } | { kind: "help" };

export function parseArgs(rawArgs: ReadonlyArray<string>): ParseResult {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: [...rawArgs],
      options: {
        manifests: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    throw translateParseArgsError(err);
  }
  if (values.help) return { kind: "help" };
  return { kind: "args", args: { manifests: values.manifests ?? "./manifests" } };
}

function printHelp(): void {
  stdout.write(`mantle-spec introspect — dump parsed manifest tree as JSON

Usage: mantle-spec introspect [--manifests <dir>]

Options:
  --manifests <dir>   Directory containing YAML manifests (default: ./manifests)
  -h, --help          This help

Output: JSON object with keys { schemas, views, procedures, triggers,
parseErrors }. Each entry surfaces its derived shape — auth requirements,
http source method+path, builtin op, lifecycle hooks, view params
schema, view filter AST.
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
  const { parsed: manifestSet, parseErrors } = await loadManifestsFromRoot(parsed.args.manifests);
  const result = IntrospectManifestsUseCase.run({ parsed: manifestSet, parseErrors });
  stdout.write(JSON.stringify(result, null, 2) + "\n");
  return parseErrors.some((d) => d.severity === "error") ? 1 : 0;
}
