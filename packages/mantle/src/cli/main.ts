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
  Optional surfaces — take only what you need. Admin is opt-in. You can ship a
  complete service with no Dev UI, no visitor frontend, and no extra packages.

  Minimal — Spec + generate
    validate + generate compile manifests into a sealed plan and typed binding.
    Embed that binding in an existing host. No Admin, no visitor UI.

  Runtime / adapter
    Bind Runtime through an adapter (Cloudflare Worker, Bun, Vercel, or yours).
    HTTP Views, MCP, and Auth work without Admin.
    See docs/examples/host-minimal-worker or
    node_modules/@aotter/mantle/docs/examples/host-minimal-worker.

  Opt-in — Admin / Dev UI
    Add @aotter/mantle-admin and @aotter/mantle-admin-ui only when humans need
    a console. Then re-run generate, bind wrangler ASSETS, and open
    /admin/sign-in (local email OTP via ConsoleEmailSender).
    See docs/examples/host-local-admin-otp or
    node_modules/@aotter/mantle/docs/examples/host-local-admin-otp.

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

Documentation:
  Handbook:      node_modules/@aotter/mantle/docs/handbook/ (or docs/handbook/)
  Online:        https://mantle.tools/
  Install skill: npx skills add aotter/mantle@v0.1.3-alpha.1 --skill install
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
