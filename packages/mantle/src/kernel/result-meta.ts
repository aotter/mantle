/** An MCP content block as the installed SDK defines `ContentBlock`; the SDK checks its shape. */
export type McpContentBlock = { readonly type: string } & Readonly<Record<string, unknown>>;
/** Type-only: set by `withResult`, so a plain `{ data }` object is not a wrapper (only the runtime mark unwraps one). */
declare const wrapper: unique symbol;
/** What `withResult` returns: `data` is the tool result as usual; `content` and `_meta` reach only the `tools/call` result. */
export interface ResultWith<T> {
  readonly [wrapper]: true;
  readonly data: T;
  /** Sent after Core's own blocks (the JSON text of `data`, the version line, the page notice). */
  readonly content?: readonly McpContentBlock[];
  /** Merged into the result `_meta`; `net.aotter.mantle/tool` wins. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}
/** What `withResultMeta` returns: `data` is the tool result as usual, `_meta` goes only to the `tools/call` result `_meta`. */
export interface ResultWithMeta<T> {
  readonly [wrapper]: true;
  readonly data: T;
  readonly _meta: Readonly<Record<string, unknown>>;
}
/**
 * Returned from a tool's `run` or a ref Procedure's handler: MCP sends `data` exactly as an unwrapped return (its JSON
 * text first, and as `structuredContent`), then `content` after Core's blocks, and `_meta` only in the result `_meta`.
 * A block the SDK refuses fails the call as an internal error. `callTool` returns the wrapper itself (`resultData`
 * unwraps it); drop `_meta` before forwarding to a model.
 */
export const withResult = <T>(data: T, extra: Pick<ResultWith<T>, "content" | "_meta">): ResultWith<T> =>
  ({ [Symbol.for("net.aotter.mantle/result")]: true, data, ...extra }) as ResultWith<T>;
/**
 * The data of a `withResult` or `withResultMeta` wrapper, any other value as it is: what a Store, REST or Admin caller
 * of a ref Procedure receives, and a `callTool` result without its blocks and `_meta`.
 */
export const resultData = <T>(value: T | ResultWith<T> | ResultWithMeta<T>): T =>
  value && typeof value === "object" && Symbol.for("net.aotter.mantle/result") in value
    ? (value as ResultWith<T>).data
    : (value as T);
/** `withResult(data, { _meta: meta })`: `meta` reaches only the result `_meta`, beside `net.aotter.mantle/tool`, which it cannot replace. */
export const withResultMeta = <T>(data: T, meta: Readonly<Record<string, unknown>>): ResultWithMeta<T> =>
  withResult(data, { _meta: meta }) as ResultWithMeta<T>;
