/** Unsupported declarations fail at generation, never silently lose their behavior. */
import type { GenerateInput, GenerateDiagnostic } from "../domain/model.js";
import { STAFF_ROLES } from "../domain/visibility.js";
import { viewOutputs } from "@aotter/mantle/spec";

export function refuseDeclarations({ plan }: GenerateInput, diagnostics: GenerateDiagnostic[]): void {
  const refuse = (path: string, message: string) => diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message });
  for (const [name, trigger] of Object.entries(plan.triggers)) {
    const kind = trigger.source.kind;
    if (kind === "http" || kind === "mcp") continue;
    refuse(`triggers/${name}`, kind === "schedule" ? "Schedule Triggers are unsupported. Wire scheduled() yourself." : "Before/after lifecycle hooks are unsupported. Write a custom handler.");
  }
  for (const [name, schema] of Object.entries(plan.schemas)) {
    if (schema.localized) refuse(`schemas/${name}/localized`, "Localized entries are unsupported until 0.2.x. Manage locales in application-owned fields and handlers.");
    if (schema.translates) refuse(`schemas/${name}/translates`, "Translation relationships are unsupported until 0.2.x. Manage relationships in application-owned fields and handlers.");
  }
  for (const [kind, declarations] of [["views", plan.views], ["procedures", plan.procedures]] as const) {
    for (const [name, declaration] of Object.entries(declarations)) {
      const roles = (node: unknown, path: string): void => {
        if (Array.isArray(node)) { node.forEach((child, index) => roles(child, `${path}/${index}`)); return; }
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (key === "ctx.staff" && Array.isArray(value)) for (const role of value) {
            if (!(STAFF_ROLES as readonly string[]).includes(role)) refuse(`${path}/ctx.staff`, `Role '${role}' is outside the generated vocabulary (${STAFF_ROLES.join(", ")}). Migrate 0.2 owner/editor/contributor users and requires declarations to 'staff'; other Caller role strings remain application-owned.`);
          } else roles(value, `${path}/${key}`);
        }
      };
      roles(declaration.requires?.auth, `${kind}/${name}/requires/auth`);
      if (declaration.requires?.guard) refuse(`${kind}/${name}/requires/guard`, "Dynamic authorization guards are unsupported. Write a custom handler that checks authorization before executing queries.");
    }
  }
  for (const [name, view] of Object.entries(plan.views)) {
    for (const [key, column] of Object.entries(viewOutputs(view, plan.schemas, new Map(), true).columns)) if (plan.schemas[column.schema]?.fields[column.field] === "geo") {
      refuse(`views/${name}/columns/${key}`, "Native geo projection is unsupported. Select the latitude and longitude columns explicitly.");
    }
  }
}
