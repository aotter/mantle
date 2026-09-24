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

export const MANTLE_OVERVIEW = `mantle — compile manifests and assemble selected application features

Overview
  New applications default to Spec, Runtime, API, MCP, Admin, and a blank Web
  home. Pass --host cf or --host chatgpt-sites, or use --features for a smaller
  positive selection. Existing authored applications keep compile-only mode.

  Host-free — Spec only
    mantle generate --features spec compiles a sealed plan and typed binding
    without Runtime, Admin, visitor UI, or a host.

  Runtime / adapter
    Bind Runtime through an adapter (Cloudflare Worker, Bun, Vercel, or yours).
    HTTP Views, MCP, and Auth work without Admin.
    See docs/examples/host-minimal-worker or
    node_modules/@aotter/mantle/docs/examples/host-minimal-worker.

  Selected Admin / Dev UI
    New full applications include the prebuilt UI. Reduced applications can
    omit it; selected packages must be installed before generation completes.
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
  Start:         node_modules/@aotter/mantle/docs/handbook/start/overview.md
  Features:      node_modules/@aotter/mantle/docs/handbook/reference/features.md
  Admin UI:      node_modules/@aotter/mantle/docs/handbook/guides/admin-ui.md
  Online:        https://mantle.tools/
  Install skill: npx skills add aotter/mantle
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
