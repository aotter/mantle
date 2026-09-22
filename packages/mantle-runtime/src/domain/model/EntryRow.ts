import type { ContentState, Entry, JsonSchema, SchemaManifest } from "@aotter/mantle-spec";

/**
 * `EntryRow` — semantic stored-record shape. SQLite/D1 projects it onto one
 * native table per Schema; non-SQL adapters preserve the same contract.
 * `version` is OCC and bumps on every persisted update.
 */
export interface EntryRow {
  readonly id: string;
  readonly collection: string;
  /** Lifted from `data.locale` at read time (ADR-0010). `undefined`
   *  when the Schema is not localized or the entry doesn't carry a
   *  locale. */
  readonly locale?: string;
  readonly status: ContentState;
  readonly version: number;
  readonly data: Record<string, unknown>;
  readonly authorId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Lift `data.locale` to the top-level `locale?` field. Centralised so
 * every repository impl (DatabaseDriver-backed, in-memory test fake,
 * future adapters) derives the convenience field the same way —
 * adding a per-impl hydration helper would let them drift.
 */
export function liftLocale(
  data: Record<string, unknown>,
): string | undefined {
  const v = data["locale"];
  return typeof v === "string" ? v : undefined;
}

/** Native SQL represents an omitted nullable field as NULL. Apply the same
 * projection in semantic adapters so preview and deployed reads agree. */
export function materializeNullableFields(
  schema: SchemaManifest,
  data: Record<string, unknown>,
): Record<string, unknown> {
  let output: Record<string, unknown> | undefined;
  for (const [name, property] of Object.entries(schema.spec.schema.properties ?? {})) {
    if (Object.hasOwn(data, name) || !isNullableJsonSchema(property)) continue;
    output ??= { ...data };
    output[name] = null;
  }
  return output ?? data;
}

/** `nullable: true` and `type`/`oneOf` that include `null` are the same persistence spelling. */
export function isNullableJsonSchema(property: JsonSchema): boolean {
  if (property.nullable === true) return true;
  const types = typeof property.type === "string" ? [property.type] : property.type ?? [];
  return types.includes("null") || property.oneOf?.some(isNullableJsonSchema) === true;
}

/** Explicit public projection. Keep this field-by-field so adding another
 * persistence-only property to `EntryRow` cannot silently expose it. */
export function projectPublicEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale,
    status: row.status,
    version: row.version,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class EntryVersionConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`version conflict on ${id}: expected ${expected}, found ${actual}`);
    this.name = "EntryVersionConflict";
  }
}

/**
 * Thrown by `transitionStatus({ expectedStatus })` when the row's
 * current status doesn't match. Distinct from version conflict
 * because it carries `ContentState` instead of numeric version, so
 * the orchestration layer can emit a tailored CONFLICT diagnostic
 * (e.g. "expected 'draft', found 'published'").
 */
export class EntryStatusConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: ContentState,
    public readonly actual: ContentState,
  ) {
    super(`status conflict on ${id}: expected ${expected}, found ${actual}`);
    this.name = "EntryStatusConflict";
  }
}

/**
 * Thrown by repository implementations when an insert or update violates
 * a Schema unique index constraint.
 */
export class EntryUniqueConflict extends Error {
  constructor(
    public readonly collection: string,
    public readonly fields: Record<string, unknown> | readonly string[],
    message?: string,
  ) {
    const detail = Array.isArray(fields)
      ? fields.join(", ")
      : Object.entries(fields)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
    super(message ?? `unique conflict in collection '${collection}' on (${detail})`);
    this.name = "EntryUniqueConflict";
  }
}
