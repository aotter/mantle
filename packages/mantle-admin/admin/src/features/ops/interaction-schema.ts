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
 * The parent scope of a list that shows `collection` under `scope`: only when the scope is the child's own
 * `nav.parentField` relationship, so a list scoped by any other reference binds nothing.
 */
export function workbenchParentScope(
  collection: Pick<Collection, "parent"> | undefined,
  scope: { field: string; value: string } | undefined,
): ParentScope | undefined {
  const parent = collection?.parent;
  if (!scope || !parent || scope.field !== parent.childField) return undefined;
  return { ...scope, parent: parent.collection, parentField: parent.parentField };
}

/** The scope's value as the input takes it: a number for a numeric input, a string otherwise; any other type binds nothing. */
function inputValue(property: JsonSchema, value: string): string | number | undefined {
  const types = property.type === undefined ? ["string"] : Array.isArray(property.type) ? property.type : [property.type];
  if (types.includes("string")) return value;
  const number = Number(value);
  if (types.includes("integer") && Number.isSafeInteger(number) && value.trim() !== "") return number;
  if (types.includes("number") && Number.isFinite(number) && value.trim() !== "") return number;
  return undefined;
}

/**
 * A child collection's action run from its folded panel: the input named exactly like the child's `nav.parentField`
 * takes the parent's value, bound like a row field (hidden from the form, shown as bound, never edited). An input of
 * that name whose `x-mantle-ref` names another Schema or key, or whose type cannot hold the parent's value, is not that
 * parent and stays the person's; so does every other input.
 */
export function parentScopeInteraction(input: JsonSchema, scope: ParentScope | undefined): {
  interaction: AdminOperationInteraction;
  row: Record<string, unknown>;
} | undefined {
  const property = scope ? input.properties?.[scope.field] : undefined;
  if (!scope || !property) return undefined;
  const ref = mantleRefOf(property);
  if (ref && (ref.schema !== scope.parent || ref.field !== scope.parentField)) return undefined;
  const value = inputValue(property, scope.value);
  if (value === undefined) return undefined;
  return {
    interaction: { collection: scope.parent, bind: [{ input: scope.field, field: scope.field }], mutates: true },
    row: { [scope.field]: value },
  };
}
