import { isFoldedFieldChild } from "../../lib/collection-nav";
import { mantleRefOf, type AdminOperationInteraction, type Collection, type JsonSchema } from "../../lib/types";

/** Inputs Admin fills itself: an idempotency key, minted once per dialog. */
export function idempotencyFields(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}

/** The operation's input without the fields Admin binds or fills itself. */
export function operationFormSchema(schema: JsonSchema, hiddenFields: readonly string[]): JsonSchema {
  const hidden = new Set(hiddenFields);
  const properties = { ...(schema.properties ?? {}) };
  for (const name of hidden) delete properties[name];
  return {
    ...schema,
    properties,
    required: (schema.required ?? []).filter((name) => !hidden.has(name)),
  };
}

/**
 * A folded child list inside its parent's workbench: the child's `nav.parentField` (`field`) holds `value`, the
 * parent's `parentField` in `parent`.
 */
export type ParentScope = { field: string; value: string; parent: string; parentField: string };

/**
 * A child collection's action run from its folded panel: the input named exactly like the child's `nav.parentField`
 * takes the parent's value, bound like a row field (shown, never edited). An input whose `x-mantle-ref` names
 * another Schema or key is not that parent and stays the person's; so does every other input.
 */
export function parentScopeInteraction(input: JsonSchema, scope: ParentScope | undefined): {
  interaction: AdminOperationInteraction;
  row: Record<string, unknown>;
} | undefined {
  const property = scope ? input.properties?.[scope.field] : undefined;
  if (!scope || !property) return undefined;
  const ref = mantleRefOf(property);
  if (ref && (ref.schema !== scope.parent || ref.field !== scope.parentField)) return undefined;
  return {
    interaction: { collection: scope.parent, bind: [{ input: scope.field, field: scope.field }], mutates: true },
    row: { [scope.field]: scope.value },
  };
}

/** A ref picker's list narrowed to one parent's children: `<field> = <value>`, as the folded child list is scoped. */
export type RefScope = { field: string; value: string };

/**
 * The ref pickers of an operation bound to a row (`target`): an `x-mantle-ref` input to a Schema that folds under the
 * bound row's collection (`nav.parentField`) lists only that row's children. Other inputs list the whole target.
 */
export function parentRefScopes(
  input: JsonSchema,
  interaction: Pick<AdminOperationInteraction, "collection"> | undefined,
  row: Readonly<Record<string, unknown>> | undefined,
  collections: readonly Collection[] | undefined,
): Record<string, RefScope> {
  const scopes: Record<string, RefScope> = {};
  if (!interaction || !row) return scopes;
  for (const [name, property] of Object.entries(input.properties ?? {})) {
    const ref = mantleRefOf(property);
    const child = ref && collections?.find((collection) => collection.name === ref.schema);
    if (!child?.parent || !isFoldedFieldChild(child, interaction.collection)) continue;
    const value = row[child.parent.parentField];
    if ((typeof value === "string" && value !== "") || typeof value === "number") scopes[name] = { field: child.parent.childField, value: String(value) };
  }
  return scopes;
}
