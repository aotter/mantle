/** Ref contracts become application functions; no interpreter or registration dependency. */
import type { JsonSchema, RuntimePlan } from "../build/compiler.js";
import { authLines as auth } from "../domain/input.js";
import { q } from "../domain/entry.js";

export function emitHandlers(
  plan: RuntimePlan,
  interactive: boolean,
  typeOf: (schema: JsonSchema | undefined) => string,
  declarations: string[],
  procedures: string[],
): string[] {
  const refs = Object.entries(plan.procedures)
    .sort()
    .map(([name, procedure], index) => ({ name, procedure, index }))
    .filter(({ procedure }) => "ref" in procedure.handler);
  // An empty contract keeps app wiring (`handlers: Handlers = {}`) identical whether or not any ref Procedure exists.
  if (!refs.length) {
    declarations.push("export interface Handlers {}");
    return [];
  }
  declarations.push(
    'export type HandlerStore = Pick<ReturnType<typeof makeStore>, "collection" | "batch" | "views" | "procedures">;',
    "type HandlerData<Native extends boolean> = { readonly store: HandlerStore } & (Native extends true ? { readonly db: Database } : unknown);",
    // D1 has no interactive transactions, so its handlers get no `transaction`: using one there fails typecheck.
    `export type HandlerContext<Native extends boolean = false> = HandlerData<Native> & { readonly caller: Caller;${interactive ? " readonly transaction: <R>(fn: (ctx: HandlerData<Native>) => Promise<R>) => Promise<R>;" : ""} };`,
    "export interface Handlers {",
    // Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
    // A handler's return admits the `withResult` wrapper (seam `ref-handler-result`).
    ...refs.map(
      ({ name, procedure, index }) =>
        `  readonly [${q(name)}]: (ctx: HandlerContext${procedure.db === "native" ? "<true>" : ""}, input: Procedure${index}Input) => Promise<Procedure${index}Output | ResultWith<Procedure${index}Output>>;`,
    ),
    "}",
  );
  const results: string[] = [];
  for (const { name, procedure, index } of refs) {
    const path = `procedures/${name}`,
      fn = `procedure${index}`;
    const native = procedure.db === "native";
    declarations.push(
      `export type Procedure${index}Input = ${typeOf(procedure.input ?? { type: "object", additionalProperties: false })};`,
      `export type Procedure${index}Output = ${typeOf(procedure.output)};`,
      // The handler's own return, a `withResult` wrapper included: the generated MCP tool sends its blocks and `_meta`.
      `async function ${fn}Result(db: Database, caller: Caller, raw: Procedure${index}Input, context: { handlers: Handlers; store: HandlerContext["store"] }): Promise<Procedure${index}Output | ResultWith<Procedure${index}Output>> {`,
      `  if ("authenticatedAs" in caller && caller.authenticatedAs === "snapshot") (await import("@aotter/mantle/host-caller")).checkFresh(caller, false, ${q(path)});`,
      ...auth(procedure.requires, path),
      "  const handlers = context?.handlers;",
      `  const handler = handlers && Object.hasOwn(handlers, ${q(name)}) ? handlers[${q(name)}] : undefined;`,
      `  if (!handler) throw new ContractError("HANDLER_NOT_REGISTERED", "Procedure handler is not registered.", ${q(path)});`,
      // TODO #1470: REST/MCP use shared generated validators at the boundary; bare calls stay typed.
      `  return handler({ caller, store: handlerStore(context.store)${native ? ", db" : ""}${interactive ? `, transaction: handlerTransaction(context.store, db, ${native})` : ""} }, raw);`,
      "}",
      // Store callers, REST and `ctx.store.procedures` get the data alone.
      `const ${fn} = async (...args: Parameters<typeof ${fn}Result>): Promise<Procedure${index}Output> => resultData(await ${fn}Result(...args));`,
    );
    procedures.push(`[${q(name)}]: ${fn}`);
    results.push(`[${q(name)}]: ${fn}Result`);
  }
  declarations.push(`export const handlerResults = { ${results.join(", ")} };`);
  return refs.map(({ name }) => name);
}
