import type { JsonSchema } from "../../lib/types";

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

