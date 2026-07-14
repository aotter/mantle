/**
 * Translate `node:util` parseArgs errors into this CLI's own phrasing.
 * Each subcommand's `run()` catches parse failures and prints
 * `err.message` verbatim, so the messages produced here are the
 * user-facing contract (`Unknown argument: --bogus` etc. — see
 * validate-cli.test.ts / cli-emit.test.ts).
 *
 * Returns the error to throw so call sites read
 * `throw translateParseArgsError(err, {...})`.
 *
 * `missingValueMessages` maps a long flag (`"--output"`) to the
 * message thrown when its value is missing; flags not in the map get
 * a generic `<flag> requires a value`.
 */
export function translateParseArgsError(
  err: unknown,
  missingValueMessages: Readonly<Record<string, string>> = {},
): unknown {
  if (!(err instanceof Error)) return err;
  const code = (err as NodeJS.ErrnoException).code;
  const quoted = /'([^']*)'/.exec(err.message)?.[1];
  if (
    code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
    code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
  ) {
    return new Error(`Unknown argument: ${quoted ?? err.message}`);
  }
  if (
    code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" &&
    err.message.endsWith("argument missing")
  ) {
    // `quoted` is "--phase <value>" or "-o, --output <value>" — pull
    // the long flag out for the message lookup.
    const flag = /--[^\s,]+/.exec(quoted ?? "")?.[0];
    if (flag) return new Error(missingValueMessages[flag] ?? `${flag} requires a value`);
  }
  return err;
}
