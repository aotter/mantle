import { writeFile } from "node:fs/promises";
import { stdout, stderr } from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { EmitOpenapiUseCase } from "../../usecase/EmitOpenapiUseCase.js";
import { ValidateManifestsUseCase } from "../../usecase/ValidateManifestsUseCase.js";
import { loadManifestsFromRoot } from "./loadManifests.js";
import { translateParseArgsError } from "./parseArgsError.js";

export interface EmitOpenapiArgs {
  readonly manifests: string;
  readonly title: string;
  readonly version: string;
  readonly sessionCookieName?: string;
  readonly output?: string;
}

export type ParseResult = { kind: "args"; args: EmitOpenapiArgs } | { kind: "help" };

export function parseArgs(rawArgs: ReadonlyArray<string>): ParseResult {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: [...rawArgs],
      options: {
        manifests: { type: "string" },
        title: { type: "string" },
        version: { type: "string" },
        "session-cookie-name": { type: "string" },
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
      title: values.title ?? "mantle",
      version: values.version ?? "0.1.0",
      sessionCookieName: values["session-cookie-name"],
      output: values.output,
    },
  };
}

function printHelp(): void {
  stdout.write(`mantle emit-openapi — emit OpenAPI 3.1 from manifests

Usage: mantle emit-openapi [options]

Options:
  --manifests <dir>            Manifest root (default: ./manifests)
  --title <str>                OpenAPI info.title (default: mantle)
  --version <str>              OpenAPI info.version (default: 0.1.0)
  --session-cookie-name <str>  Better Auth session-cookie name used
                               in the cookieAuth security scheme for
                               auth-gated Views. Default
                               '__Secure-better-auth.session_token'
                               (production, HTTPS); pass
                               'better-auth.session_token' for local
                               non-secure deploys.
  -o, --output <file>          Write UTF-8 JSON to a file. Prefer this
                               over shell redirection on Windows.
  -h, --help                   This help

Output: OpenAPI 3.1 JSON on stdout unless --output is set.

Covers HTTP Triggers (POST/PUT/PATCH/DELETE) and View REST routes
(GET /api/views/<name>). MCP is out of scope.
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
  const { manifests, parseErrors } = await loadManifestsFromRoot(args.manifests);
  if (parseErrors.some((d) => d.severity === "error")) {
    stderr.write(`Manifest parse errors — run \`mantle validate\` to inspect.\n`);
    return 1;
  }
  // Semantic validation gate. Without it, a method+path collision
  // between two HTTP Triggers (only caught by ValidateManifests, not
  // the parser) would silently overwrite one operation and emit a
  // document missing a real route. (#398)
  const { errorCount } = ValidateManifestsUseCase.run({ manifests });
  if (errorCount > 0) {
    stderr.write(
      `Manifest validation errors (e.g. duplicate route) — run \`mantle validate\` to inspect.\n`,
    );
    return 1;
  }
  const { document } = EmitOpenapiUseCase.run({
    manifests,
    title: args.title,
    version: args.version,
    sessionCookieName: args.sessionCookieName,
  });
  const body = JSON.stringify(document, null, 2) + "\n";
  if (args.output) {
    await writeFile(args.output, body, "utf8");
  } else {
    stdout.write(body);
  }
  return 0;
}
