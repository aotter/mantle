#!/usr/bin/env node
import { argv, stderr, stdout } from "node:process";
import {
  runEmitOpenapi,
  runValidate,
} from "@aotter/mantle-spec/cli";
import { runGenerate } from "./generate.js";
import { runSkills } from "./skills.js";

async function main(): Promise<number> {
  const command = argv[2];
  if (!command || command === "--help" || command === "-h") {
    stdout.write(`${MANTLE_OVERVIEW}
`);
    return command ? 0 : 2;
  }
  const rest = argv.slice(3);
  switch (command) {
    case "generate":
      return runGenerate(rest);
    case "skills":
      return runSkills(rest);
    case "validate":
      return runValidate(rest);
    case "emit-openapi":
      return runEmitOpenapi(rest);
    default:
      stderr.write(`Unknown subcommand: ${command}\n`);
      return 2;
  }
}

export const MANTLE_OVERVIEW = `mantle — compile manifests into a RuntimePlan and typed binding

Overview
  Layered authoring. Start at Minimal; open the next surface only when needed.

  Minimal
    generate + validate compile manifests into a sealed plan and typed binding.
    API-only. No Admin, no visitor UI.

  Next — Admin / Dev UI
    Install @aotter/mantle-admin and @aotter/mantle-admin-ui, re-run generate,
    bind wrangler ASSETS to ./public, then pnpm dev and open /admin/sign-in.
    Local email OTP is printed by ConsoleEmailSender. See
    docs/examples/local-admin-otp and docs/handbook/start/quickstart-admin.md.

  Further (ask the subcommand for details)
    skills          project version-matched agent instructions
    emit-openapi    OpenAPI 3.1 from HTTP Triggers and Views
    mantle-harness  measure indexes and live HTTP (separate binary)

Usage: mantle <subcommand> [options]

Subcommands:
  generate       Compile manifests into a typed runtime binding
  validate       Static manifest and handler-source validation
  skills         Project version-matched Core skills
  emit-openapi   Emit OpenAPI 3.1 from Triggers and Views
`;

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    stderr.write(`internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
