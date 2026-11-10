/** What `withResultMeta` returns: `data` is the tool result as usual, `_meta` goes only to the `tools/call` result `_meta`. */
export interface ResultWithMeta<T> {
  readonly data: T;
  readonly _meta: Readonly<Record<string, unknown>>;
}
/**
 * Returned from a tool's `run`: MCP sends `data` exactly as an unwrapped return, and `meta` only in the result `_meta`
 * (beside `net.aotter.mantle/tool`, which it cannot replace). `callTool` returns the wrapper itself; drop `_meta` before forwarding to a model.
 */
export const withResultMeta = <T>(data: T, meta: Readonly<Record<string, unknown>>): ResultWithMeta<T> =>
  ({ [Symbol.for("net.aotter.mantle/result")]: true, data, _meta: meta }) as ResultWithMeta<T>;
