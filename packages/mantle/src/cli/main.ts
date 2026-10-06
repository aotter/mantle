#!/usr/bin/env node
/** The `mantle` bin (ADR-0032 amendment "mantle generate"): one command, `generate`; `generate --check` is the validation gate. */
import { argv, exit, stderr, stdout } from "node:process";
import { runGenerate } from "./generate.js";

const COMMANDS: Record<string, (args: readonly string[]) => Promise<number>> = {
  generate: runGenerate,
};

const sub = argv[2];
const command = sub && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
if (!command) {
  (sub && sub !== "--help" && sub !== "-h" ? stderr : stdout).write(`${sub && sub !== "--help" && sub !== "-h" ? `Unknown subcommand: ${sub}\n\n` : ""}Usage: mantle <${Object.keys(COMMANDS).join(" | ")}> [options]

Run \`mantle <subcommand> --help\` for its options.
`);
  exit(sub === "--help" || sub === "-h" ? 0 : 2);
}
command(argv.slice(3)).then(exit, (err: unknown) => {
  stderr.write(`internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  exit(2);
});
