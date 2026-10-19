import { z, type ZodType } from "zod";
import type { JsonSchema } from "../model/ManifestGrammar.js";

/**
 * Thin boundary around Zod's official JSON Schema importer. Mantle keeps
 * only its legacy `nullable` normalization, an input-depth guard and the
 * length-before-pattern order here; JSON Schema semantics belong to Zod.
 */
export function jsonSchemaToZod(schema: JsonSchema): ZodType {
  let imported: ZodType;
  try {
    imported = lengthBeforePattern(z.fromJSONSchema(normalizeNullable(schema) as never));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    imported = z.never({ error: `Invalid JSON Schema: ${message}` });
  }
  return jsonValueWithinLimits().pipe(imported);
}

/**
 * Zod checks a string's `maxLength` before its `pattern` but runs the pattern even when the length failed. The CLI bounds a
 * pattern's backtracking only up to the declared maxLength (branches × maxLength^e), so a longer string must stop at the length check:
 * every string schema's maxLength check aborts the checks after it.
 */
function lengthBeforePattern(root: ZodType): ZodType {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) {
      for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child);
      return;
    }
    if (def["type"] === "string") {
      for (const check of (def["checks"] ?? []) as { _zod: { def: { check?: string; abort?: boolean } } }[]) {
        if (check._zod.def.check === "max_length") check._zod.def.abort = true;
      }
    }
    for (const [key, child] of Object.entries(def)) {
      if (key === "checks") continue;
      visit(key === "getter" && typeof child === "function" ? (child as () => unknown)() : child);
    }
  };
  visit(root);
  return root;
}

function normalizeNullable(schema: JsonSchema): JsonSchema {
  const transform = (node: JsonSchema): JsonSchema => {
    const out: Record<string, unknown> = { ...node };
    if (node.format === "url") out["format"] = "uri";
    if (node.properties) {
      out["properties"] = Object.fromEntries(
        Object.entries(node.properties).map(([name, child]) => [name, transform(child)]),
      );
    }
    if (node.$defs) {
      out["$defs"] = Object.fromEntries(
        Object.entries(node.$defs).map(([name, child]) => [name, transform(child)]),
      );
    }
    if (node.items) out["items"] = transform(node.items);
    if (typeof node.additionalProperties === "object") {
      out["additionalProperties"] = transform(node.additionalProperties);
    }
    if (node.oneOf) out["oneOf"] = node.oneOf.map(transform);
    delete out["nullable"];
    if (node.nullable === true) {
      if (typeof node.type === "string") out["type"] = [node.type, "null"];
      else if (Array.isArray(node.type) && !node.type.includes("null")) {
        out["type"] = [...node.type, "null"];
      } else if (node.type === undefined) {
        const { $defs, ...base } = out;
        const definitions = $defs as JsonSchema["$defs"];
        return {
          ...(definitions ? { $defs: definitions } : {}),
          oneOf: [base as JsonSchema, { type: "null" }],
        };
      }
    }
    return out as JsonSchema;
  };
  return transform(schema);
}

function jsonValueWithinLimits(): ZodType {
  return z.unknown().superRefine((value, ctx) => {
    const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
    const active = new WeakSet<object>();
    let nodes = 0;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.value === null || typeof current.value !== "object") continue;
      if (current.exit) {
        active.delete(current.value);
        continue;
      }
      if (active.has(current.value)) {
        ctx.addIssue({ code: "custom", message: "value must not contain object cycles" });
        return;
      }
      active.add(current.value);
      if (current.depth > 100 || ++nodes > 10_000) {
        ctx.addIssue({ code: "custom", message: "value exceeds JSON Schema validation limits" });
        return;
      }
      stack.push({ ...current, exit: true });
      for (const child of Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  });
}
