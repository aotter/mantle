/** How a REST route binds a request to its operation (ADR-0047 §2.5): one derivation for the generator and describe. */
import type { RuntimePlan } from "../build/compiler.js";

export interface RestBinding {
  /** Each `{name}` path parameter and the scalar it is read as. */
  readonly path: Readonly<Record<string, "string" | "number" | "boolean">>;
  readonly input: "query" | "body";
  /** Repeated, colliding and undeclared query parameters are refused. */
  readonly strict: boolean;
  /** HEAD is answered like GET, without a body. */
  readonly head: boolean;
  readonly response: "page" | "result";
}

/** The binding of an http Trigger, or of a public View's generated `GET /api/views/<name>` route when given its name. */
export function restBinding(plan: RuntimePlan, operation: RuntimePlan["triggers"][string] | string): RestBinding {
  if (typeof operation === "string") return { path: {}, input: "query", strict: false, head: true, response: "page" };
  const view = "view" in operation,
    properties = (view ? plan.views[operation.view] : plan.procedures[operation.procedure])?.input?.properties;
  const path: RestBinding["path"] = Object.fromEntries(
    operation.source.kind === "http"
      ? [...operation.source.path.matchAll(/\{([^}]+)\}/g)].map(([, key]) => {
          const type = [properties?.[key!]?.type].flat().find(t => t && t !== "null");
          return [
            key!,
            type === "integer" || type === "number" ? "number" : type === "boolean" ? "boolean" : "string",
          ] as const;
        })
      : [],
  );
  return view
    ? { path, input: "query", strict: true, head: false, response: "page" }
    : { path, input: "body", strict: false, head: false, response: "result" };
}
