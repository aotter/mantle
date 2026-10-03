import { z, type ZodType } from "zod";
import type { JsonSchema } from "../model/ManifestGrammar.js";

/**
 * Thin boundary around Zod's official JSON Schema importer. Mantle keeps
 * only its legacy `nullable` normalization and an input-depth guard here;
 * JSON Schema semantics belong to Zod.
 */
export function jsonSchemaToZod(schema: JsonSchema): ZodType {
  let imported: ZodType;
  try {
    imported = z.fromJSONSchema(normalizeNullable(schema) as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    imported = z.never({ error: `Invalid JSON Schema: ${message}` });
  }
  return jsonValueWithinLimits().pipe(imported);
}

/**
 * `schema.safeParse(value)`, where anything the validator throws other than a Zod issue (a stack overflow on a schema nobody
 * checked) is a failed parse: a value the schema cannot check is not accepted, and the caller reports it as it reports any.
 */
export function safeParseJson<T extends ZodType>(schema: T, value: unknown): ReturnType<T["safeParse"]> {
  try {
    return schema.safeParse(value) as ReturnType<T["safeParse"]>;
  } catch (error) {
    const message = `the schema cannot check this value: ${error instanceof Error ? error.message : String(error)}`;
    return { success: false, error: new z.ZodError([{ code: "custom", path: [], message, input: value }]) } as ReturnType<T["safeParse"]>;
  }
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

/**
 * Convert a zod issue path (`PropertyKey[]`) to an RFC 6901 JSON
 * Pointer string. Empty path → `""`; `["foo", 0, "bar"]` → `"/foo/0/bar"`;
 * field names containing `/` or `~` are escaped per the spec
 * (`~` → `~0`, `/` → `~1`).
 */
export function zodPathToJsonPointer(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return (
    "/" +
    path
      .map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

/**
 * Translate a zod `safeParse` failure to the (instancePath, message)
 * shape the dispatcher's diagnostic emitter expects.
 */
export function firstZodIssueAsJsonPointer(
  err: z.ZodError,
): { instancePath: string; message: string } {
  const issue = err.issues[0];
  if (!issue) return { instancePath: "", message: "validation failed" };
  return { instancePath: zodPathToJsonPointer(issue.path), message: issue.message };
}
