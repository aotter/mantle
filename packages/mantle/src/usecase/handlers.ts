/** Ref contracts become application functions; no interpreter or registration dependency. */
import type { JsonSchema, RuntimePlan } from "../build/compiler.js";
import { authLines as auth } from "../domain/input.js";
import { q } from "../domain/entry.js";

export function emitHandlers(
  plan: RuntimePlan, interactive: boolean,
  typeOf: (schema: JsonSchema | undefined) => string,
  declarations: string[], procedures: string[],
): string[] {
  const refs = Object.entries(plan.procedures).sort().map(([name, procedure], index) => ({ name, procedure, index })).filter(({ procedure }) => "ref" in procedure.handler);
  // An empty contract keeps app wiring (`handlers: Handlers = {}`) identical whether or not any ref Procedure exists.
  if (!refs.length) { declarations.push("export interface Handlers {}"); return []; }
  declarations.push(
    'export type HandlerStore = Pick<ReturnType<typeof makeStore>, "collection" | "batch" | "views" | "procedures">;',
    // D1 has no interactive transactions, so its handlers get no `transaction`: using one there fails typecheck.
    `export interface HandlerContext { readonly caller: Caller; readonly db: Database; readonly store: HandlerStore;${interactive ? " readonly transaction: <R>(fn: (ctx: { readonly store: HandlerStore; readonly db: Database }) => Promise<R>) => Promise<R>;" : ""} }`,
    "export interface Handlers {",
    ...refs.map(({ name, index }) => `  readonly [${q(name)}]: (ctx: HandlerContext, input: Procedure${index}Input) => Promise<Procedure${index}Output>;`),
    "}",
  );
  for (const { name, procedure, index } of refs) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    declarations.push(
      `export type Procedure${index}Input = ${typeOf(procedure.input ?? { type: "object", additionalProperties: false })};`,
      `export type Procedure${index}Output = ${typeOf(procedure.output)};`,
      `async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input, context: { handlers: Handlers; store: HandlerContext["store"] }): Promise<Procedure${index}Output> {`,
      `  if ("authenticatedAs" in caller && caller.authenticatedAs === "snapshot") (await import("@aotter/mantle/host-caller")).checkFresh(caller, false, ${q(path)});`,
      ...auth(procedure.requires, path),
      "  const handlers = context?.handlers;",
      `  const handler = handlers && Object.hasOwn(handlers, ${q(name)}) ? handlers[${q(name)}] : undefined;`,
      `  if (!handler) throw new ContractError("HANDLER_NOT_REGISTERED", "Procedure handler is not registered.", ${q(path)});`,
      // TODO #1470: REST/MCP use shared generated validators at the boundary; bare calls stay typed.
      `  return handler({ caller, db, store: context.store${interactive ? ", transaction: handlerTransaction(context.store, db)" : ""} }, raw);`,
      "}",
    );
    procedures.push(`[${q(name)}]: ${fn}`);
  }
  return refs.map(({ name }) => name);
}
