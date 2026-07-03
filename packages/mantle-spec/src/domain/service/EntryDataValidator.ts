import type { ZodType } from "zod";
import {
  jsonSchemaToZod,
  zodPathToJsonPointer,
} from "./JsonSchemaToZod.js";
import { runtimeDiagnostic, type Diagnostic } from "../../kernel/diagnostic.js";
import type { SchemaManifest } from "../model/ManifestGrammar.js";

/**
 * Per-collection entry-data validator.
 *
 * Given a parsed `SchemaManifest` and an entry payload, runs zod
 * validation against the manifest's `spec.schema` and returns
 * Diagnostics. Compiled zod schemas are cached per `metadata.name` so
 * repeated `validate()` calls are cheap; the cache is content-
 * addressed-ish — calling `validate` with two different
 * SchemaManifests that share a `metadata.name` will reuse the first
 * compile, which is correct because manifest names are unique within a
 * deployment.
 *
 * Switched from Ajv to zod (POC issue #70) because Ajv's runtime
 * `compile()` calls `new Function()`, which CF Workers blocks under
 * V8's codegen-from-strings policy. zod composes builders into a
 * plain object tree and runs them through its interpreter at parse
 * time — no codegen, Workers-safe.
 *
 * The `x-mantle-ref`, `x-mcp-hint`, `x-mantle-bind` extension keywords
 * are tolerated (the converter ignores unknown keywords; they pass
 * through unmodified).
 *
 * Output shape is `Diagnostic[]` — empty array means "valid". The
 * dispatcher and admin-write paths surface the array directly; the
 * `phase: "runtime"` stamp is correct for entry-write validation,
 * which always happens at request-handling time.
 */
export class EntryDataValidator {
  private readonly compiled: Map<string, ZodType> = new Map();

  /**
   * Validate `data` against `manifest.spec.schema`. Returns the empty
   * array on success; on failure, returns one or more Diagnostics
   * with `code: "INPUT_VALIDATION_FAILED"` and `path` set to the
   * RFC 6901 JSON Pointer of the offending field (`""` = root).
   *
   * `opts.partial` drops the schema's top-level `required` so a
   * work-in-progress draft can be saved with fields still blank. Types
   * of whatever IS present are still checked. Completeness is enforced
   * at publish time, which validates without `partial`.
   */
  validate(
    manifest: SchemaManifest,
    data: unknown,
    opts?: { partial?: boolean },
  ): readonly Diagnostic[] {
    const compiled = this.compileFor(manifest, opts?.partial ?? false);
    const result = compiled.safeParse(data);
    if (result.success) return [];
    return result.error.issues.map((issue) =>
      runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: zodPathToJsonPointer(issue.path),
        message: issue.message,
      }),
    );
  }

  /**
   * Test-only escape hatch: peek at whether a given Schema has been
   * compiled yet. The cache is otherwise an internal implementation
   * detail. Not part of the package's public API surface.
   *
   * @internal
   */
  hasCompiled(name: string): boolean {
    return this.compiled.has(name);
  }

  private compileFor(manifest: SchemaManifest, partial: boolean): ZodType {
    const name = partial ? `${manifest.metadata.name}::partial` : manifest.metadata.name;
    let compiled = this.compiled.get(name);
    if (!compiled) {
      const source = partial ? withoutTopLevelRequired(manifest.spec.schema) : manifest.spec.schema;
      compiled = jsonSchemaToZod(source);
      this.compiled.set(name, compiled);
    }
    return compiled;
  }
}

/**
 * Return a shallow copy of a JSON Schema with its top-level `required`
 * dropped, so every top-level property becomes optional. Nested object
 * `required` is left intact — it only bites when that nested object is
 * actually present, which is the right rule for a partial draft.
 */
function withoutTopLevelRequired(schema: SchemaManifest["spec"]["schema"]): SchemaManifest["spec"]["schema"] {
  if (!schema || typeof schema !== "object") return schema;
  const { required: _dropped, ...rest } = schema as Record<string, unknown>;
  return rest as SchemaManifest["spec"]["schema"];
}

/**
 * @deprecated Use {@link EntryDataValidator} directly. Kept as an
 *  alias for v0.1.0 import-name backwards-compat; will be removed in
 *  v0.2.
 */
export { EntryDataValidator as SchemaValidator };
