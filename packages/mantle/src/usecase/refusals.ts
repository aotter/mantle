/** Unsupported declarations fail at generation, never silently lose their behavior. */
import type { GenerateInput, GenerateDiagnostic } from "../domain/model.js";
import { viewOutputs } from "../build/compiler.js";

export function refuseDeclarations({ plan }: Pick<GenerateInput, "plan">, diagnostics: GenerateDiagnostic[]): void {
  const refuse = (path: string, message: string) => diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message });
  for (const [name, trigger] of Object.entries(plan.triggers)) {
    const kind = trigger.source.kind;
    if (kind === "http" || kind === "mcp") continue;
    refuse(`triggers/${name}`, kind === "schedule" ? "Schedule Triggers are unsupported. Wire scheduled() yourself." : "Before/after lifecycle hooks are unsupported. Write a custom handler.");
  }
  for (const [name, schema] of Object.entries(plan.schemas)) {
    const parent = schema.translates && plan.schemas[schema.translates.parent.toLowerCase()];
    if (parent?.scope && schema.scope !== parent.scope) refuse(`schemas/${name}/translates`, `Scoped translation parent '${schema.translates!.parent}' requires the same child scope column '${parent.scope}'. Different or missing child scope columns cannot be correlated safely.`);
  }
  for (const [kind, declarations] of [["views", plan.views], ["procedures", plan.procedures]] as const) {
    for (const [name, declaration] of Object.entries(declarations)) {
      if (declaration.requires?.guard) refuse(`${kind}/${name}/requires/guard`, "Dynamic authorization guards are unsupported. Write a custom handler that checks authorization before executing queries.");
    }
  }
  for (const [name, view] of Object.entries(plan.views)) {
    for (const [key, column] of Object.entries(viewOutputs(view, plan.schemas, new Map(), true).columns)) if (plan.schemas[column.schema]?.fields[column.field] === "geo") {
      refuse(`views/${name}/columns/${key}`, "Native geo projection is unsupported. Select the latitude and longitude columns explicitly.");
    }
  }
}
