import type { AppDescription } from "../domain/describe/index.js";
/** Routes reference selected generated boundaries, never a runtime manifest; request handling is the kernel's. */
import type { RuntimePlan, PlanLowered, LoweredStatement } from "../build/compiler.js";
import type { Target } from "../domain/model.js";
import { databaseImport, q, viewImports } from "../domain/entry.js";
import { authLines, conversions, requiredScopes } from "../domain/input.js";
import { boundaryPage, outputConversions } from "../domain/columns.js";
import { pathTemplate as template, routeOrder, routeSource } from "../kernel/route-pattern.js";
import { restBinding } from "../domain/binding.js";
export function emitRest(
  plan: RuntimePlan,
  lowered: PlanLowered,
  target: Target,
  description: AppDescription,
): Record<string, string> {
  const guard = (
    requires: RuntimePlan["views"][string]["requires"],
    path: string,
    binds: LoweredStatement["binds"] = [],
    trustedOnly = false,
  ) => {
    const lines = authLines(requires, path, binds, !target.endsWith("postgres"), trustedOnly),
      scopes = requiredScopes(requires);
    return (
      (lines.length ? `, check: (caller) => {${lines.join("")}}` : "") + (scopes.length ? `, scopes: ${q(scopes)}` : "")
    );
  };
  const userImport = plan.access ? ['import { userBinds } from "@aotter/mantle/internal/user-fields";'] : [];
  const refs = Object.values(plan.procedures).some(p => "ref" in p.handler);
  const imports = [
    ...userImport,
    'import { rest as serve, type Options } from "@aotter/mantle/rest";',
    databaseImport(target),
    ...(refs ? ['import { store, type Handlers } from "./generated.js";'] : []),
  ];
  if (
    Object.values(plan.procedures).some(p => p.trustedOnly) ||
    [...Object.values(plan.views), ...Object.values(plan.procedures)].some(p => p.requires?.auth?.all.length)
  )
    imports.push('import { deny, isAdmin, isUser } from "@aotter/mantle/contracts";');
  const views: string[] = [],
    triggered: string[] = [];
  let hasWire = false;
  const convert = (code: string) => (code ? `, convert: ${code}` : "");
  // matchTarget compiles the same source and precedence from the describe template, which `routePath` inverts exactly.
  const route = (method: string, path: string) => {
    const { source, keys } = routeSource(path);
    return `method: ${q(method)}, pattern: new RegExp(${q(source)})${keys.length ? `, keys: ${q(keys)}` : ""}`;
  };
  // A public View's route pieces, shared by its generated route and its GET Triggers (ADR-0047): one reader, one page.
  const viewRoutes = new Map<string, string>();
  for (const [name, view] of Object.entries(plan.views)) {
    if (view.surface !== "public") continue;
    const id = viewRoutes.size;
    const wire = outputConversions(plan, name, target);
    imports.push(
      ...viewImports(name, id).map(line =>
        wire.some(([, type]) => type === "int") ? line.replaceAll("./paged/views/", "./paged/wire/views/") : line,
      ),
    );
    hasWire ||= wire.length > 0;
    const binds = (lowered.views[name]?.public ?? lowered.views[name]?.caller)?.binds;
    viewRoutes.set(
      name,
      `target: ${q({ kind: "view", name })}${guard(view.requires, `views/${name}`, binds)}, query: query${id}, page: ${boundaryPage(`page${id}`, wire)}${convert(conversions(view.input?.properties, binds ?? [], target))}`,
    );
    views.push(`{ ${route("GET", `/api/views/${name}`)}, ${viewRoutes.get(name)} }`);
  }
  const triggers = Object.values(plan.triggers)
    .filter(t => t.source.kind === "http")
    .sort((a, b) =>
      a.source.kind === "http" && b.source.kind === "http" ? routeOrder(a.source.path, b.source.path) : 0,
    );
  for (const trigger of triggers) {
    if (trigger.source.kind !== "http") continue;
    const { method, path } = trigger.source,
      id = `rest:${method} ${template(path)}`,
      binding = restBinding(plan, trigger);
    if ("view" in trigger) {
      // The View's own reader and page; a strict route reads its path parameters as query parameters.
      triggered.push(
        `{ ${route(method, path)}, id: ${q(id)}, ${viewRoutes.get(trigger.view)!}${binding.strict ? ", strict: true" : ""} }`,
      );
      continue;
    }
    const name = trigger.procedure,
      procedure = plan.procedures[name]!,
      index = triggered.length,
      ref = "ref" in procedure.handler;
    imports.push(
      `import { validate as validate${index} } from "./validation/procedures/${encodeURIComponent(name)}.js";`,
    );
    const params = Object.fromEntries(Object.entries(binding.path).filter(([, type]) => type !== "string"));
    triggered.push(
      `{ ${route(method, path)}, id: ${q(id)}, target: ${q({ kind: "procedure", name })}${description.targets.find(t => t._meta.id === `procedure:${name}`)?._meta.readOnly ? ", readOnly: true" : ""}${guard(
        procedure.requires,
        `procedures/${name}`,
        lowered.procedures[name]?.caller?.flatMap(s => s.binds),
        procedure.trustedOnly,
      )}${Object.keys(params).length ? `, params: ${q(params)}` : ""}, validate: validate${index}${convert(conversions(procedure.input?.properties, lowered.procedures[name]?.caller?.flatMap(s => s.binds) ?? [], target))}, run: ${ref ? `(db, caller, input, handlers) => store(db, caller, { handlers }).procedures[${q(name)}](input)` : `async (db, caller, input) => (await import("./procedures/${encodeURIComponent(name)}.js")).default(db, caller, input)`} }`,
    );
  }
  if (hasWire) imports.push('import { wireRows } from "@aotter/mantle/contracts";');
  const list = (items: string[]) =>
    items.length ? `[\n${items.map(item => "    " + item + ",\n").join("")}  ]` : "[]";
  return {
    "rest.ts": `${imports.join("\n")}
export function rest<Env>(options: Options<Env, Database>${refs ? " & { handlers: Handlers }" : ""}): (request: Request, env: Env, ctx?: import("@aotter/mantle/contracts").RequestContext) => Promise<Response | undefined> {
  return serve<Env, Database${refs ? ", Handlers" : ""}>(${list([...views, ...triggered])}, ${plan.access ? `{...options, fields: ${q(plan.access.userFields)}, accessTargets: () => import("./access-targets.js").then(m => m.targets)}` : '{...options, accessTargets: () => import("./access-targets.js").then(m => m.targets)}'});
}
`,
  };
}
