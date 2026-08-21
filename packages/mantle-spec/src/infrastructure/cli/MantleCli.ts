#!/usr/bin/env node
/**
 * `mantle-spec` CLI dispatcher. Subcommands route to their implementing
 * module under `infrastructure/cli/`.
 */
import { argv, exit, stderr, stdout } from "node:process";
import { run as runValidate } from "./ValidateCommand.js";
import { run as runIntrospect } from "./IntrospectCommand.js";
import { run as runEmitOpenapi } from "./EmitOpenapiCommand.js";
import { run as runEmitTypes } from "./EmitTypesCommand.js";

async function main(): Promise<number> {
  const sub = argv[2];
  if (!sub || sub === "--help" || sub === "-h") {
    stdout.write(`mantle-spec - manifest authoring CLI

Usage: mantle-spec <subcommand> [options]

Subcommands:
  validate       Static manifest + handler-source validation (Loop 1)
  introspect     Dump parsed manifest tree as JSON
  emit-openapi   Emit OpenAPI 3.1 from HTTP Triggers + View REST routes
  emit-types     Emit TypeScript .d.ts from Schemas / Procedures / Views

Run \`mantle-spec <subcommand> --help\` for subcommand details.
`);
    return sub ? 0 : 2;
  }

  const rest = argv.slice(3);

  switch (sub) {
    case "validate":
      return runValidate(rest);
    case "introspect":
      return runIntrospect(rest);
    case "emit-openapi":
      return runEmitOpenapi(rest);
    case "emit-types":
      return runEmitTypes(rest);
    default:
      stderr.write(`Unknown subcommand: ${sub}\n`);
      return 2;
  }
}

main().then(
  (code) => exit(code),
  (err) => {
    stderr.write(`internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    exit(2);
  },
);
