#!/usr/bin/env node
import { argv, stderr, stdout } from "node:process";
import {
  runEmitOpenapi,
  runEmitTypes,
  runIntrospect,
  runValidate,
} from "@aotter/mantle-spec/cli";
import { runGenerate } from "./generate.js";
import { runSkills } from "./skills.js";
import { runUpdate } from "./update.js";

async function main(): Promise<number> {
  const command = argv[2];
  if (!command || command === "--help" || command === "-h") {
    stdout.write(`mantle - SDK authoring CLI

Usage: mantle <subcommand> [options]

Subcommands:
  generate       Compile manifests and handler types
  skills         Project version-matched Core skills
  update         Compare local work with provision bundles
  validate       Static manifest + handler-source validation
  introspect     Dump parsed manifest tree as JSON
  emit-openapi   Emit OpenAPI 3.1 from Triggers + Views
  emit-types     Emit TypeScript declarations from manifests
`);
    return command ? 0 : 2;
  }
  const rest = argv.slice(3);
  switch (command) {
    case "generate":
      return runGenerate(rest);
    case "skills":
      return runSkills(rest);
    case "update":
      return runUpdate(rest);
    case "validate":
      return runValidate(rest);
    case "introspect":
      return runIntrospect(rest);
    case "emit-openapi":
      return runEmitOpenapi(rest);
    case "emit-types":
      return runEmitTypes(rest);
    default:
      stderr.write(`Unknown subcommand: ${command}\n`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    stderr.write(`internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
